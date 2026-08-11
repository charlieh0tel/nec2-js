// Embind facade over nec2++'s C++ API.
//
// Deliberately not the libnecpp.h C API: that exposes only impedance and
// scalar gains, while the classes underneath carry the whole result surface --
// per-direction axial ratio and sense, per-segment currents, average power
// gain. Binding the C++ directly is what makes those reachable from
// JavaScript without patching upstream.
//
// The facade is one class rather than free functions so a caller can hold a
// solved context and read several results from it, which is how nec2++ works:
// rp_card() runs the solve and the getters read what it left behind.

#include <emscripten/bind.h>

#include <string>
#include <vector>

#include "c_geometry.h"
#include "nec_context.h"
#include "nec_exception.h"
#include "nec_radiation_pattern.h"
#include "nec_results.h"
#include "nec_structure_currents.h"

namespace {

// One direction of the far-field pattern.
struct PatternPoint {
  double totalGainDb;
  double axialRatio;
  double tiltDeg;
  // nec2++ reports sense as an index rather than a word; the JS side maps it.
  int senseIndex;
  double eThetaMagnitude;
  double eThetaPhaseDeg;
  double ePhiMagnitude;
  double ePhiPhaseDeg;
};

// One driven segment, as nec2++ reports it after a solve. Impedance is what
// the feed sees; current and voltage are what flows and is applied there.
struct Feed {
  int tag;
  int segment;
  double zReal;
  double zImag;
  double iReal;
  double iImag;
  double vReal;
  double vImag;
  double powerW;
};

// Aggregate gain statistics over the sampled pattern, in dB.
struct GainStats {
  double maxDb;
  double minDb;
  double meanDb;
  double sdDb;
};

// One segment's current. Coordinates are the segment centre, metres.
struct SegmentCurrent {
  int tag;
  int segment;
  double x;
  double y;
  double z;
  double lengthM;
  double iReal;
  double iImag;
};

// nec2++ signals errors by throwing. Emscripten cannot carry a C++ exception
// across the boundary usefully, so every entry point converts one into a JS
// Error with the message nec2++ supplied.
#define NEC_GUARD(body)                                     \
  try {                                                     \
    body                                                    \
  } catch (nec_exception * e) {                             \
    std::string message = e->get_message();                 \
    delete e;                                               \
    throw std::runtime_error(message);                      \
  } catch (int code) {                                      \
    throw std::runtime_error("nec2++ aborted with code " +  \
                             std::to_string(code));         \
  } catch (const std::exception& e) {                       \
    throw std::runtime_error(e.what());                     \
  } catch (...) {                                           \
    /* Anything left would otherwise reach JavaScript as a  \
       bare CppException with only a heap pointer in it. */ \
    throw std::runtime_error(                               \
        "nec2++ threw an unrecognised exception");          \
  }

class Nec {
 public:
  Nec() { m_context.initialize(); }

  // --- geometry ---------------------------------------------------------
  void wire(int tag, int segments, double x1, double y1, double z1, double x2,
            double y2, double z2, double radiusM) {
    // The trailing 1,1 are the tapering ratios: no taper.
    NEC_GUARD(m_context.get_geometry()->wire(tag, segments, x1, y1, z1, x2, y2,
                                             z2, radiusM, 1.0, 1.0);)
  }

  // The GM card's angles are degrees, but nec_context::move() takes radians --
  // the card parser is what converts. Doing it here keeps this facade's units
  // the same as the card's, so a caller never has to know which side of that
  // boundary it is on.
  void transform(int tagIncrement, int copies, double rotXDeg, double rotYDeg,
                 double rotZDeg, double moveXM, double moveYM, double moveZM,
                 int fromTag) {
    NEC_GUARD(m_context.move(degrees_to_rad(rotXDeg), degrees_to_rad(rotYDeg),
                             degrees_to_rad(rotZDeg), moveXM, moveYM, moveZM,
                             fromTag, copies, tagIncrement);)
  }

  // Angles are degrees; radiusM is the arc's radius, wireRadiusM the
  // conductor's.
  void arc(int tag, int segments, double radiusM, double angle1Deg,
           double angle2Deg, double wireRadiusM) {
    NEC_GUARD(m_context.arc(tag, segments, radiusM, angle1Deg, angle2Deg,
                            wireRadiusM);)
  }

  // A helix: turn spacing and total length, then the two radii at each end
  // (a1/b1 at the bottom, a2/b2 at the top) which let it be elliptical or
  // tapered. A negative length makes it left-hand wound.
  void helix(int tag, int segments, double turnSpacingM, double lengthM,
             double a1, double b1, double a2, double b2,
             double wireRadiusM) {
    NEC_GUARD(m_context.helix(tag, segments, turnSpacingM, lengthM, a1, b1, a2,
                              b2, wireRadiusM);)
  }

  // GX: reflect the structure through the coordinate planes. The digits of
  // planes select x, y and z; tagIncrement offsets the copies' tags.
  void reflect(int tagIncrement, int planes) {
    NEC_GUARD(m_context.gx_card(tagIncrement, planes);)
  }

  // gpflag: 0 free space, 1 ground plane with wires bonded to it, -1 ground
  // present but nothing touching it.
  void geometryComplete(int gpflag) {
    NEC_GUARD(m_context.geometry_complete(gpflag);)
  }

  // --- environment ------------------------------------------------------
  void groundCard(int type, int radialCount, double epsR, double sigmaSm,
                  double f3, double f4, double f5, double f6) {
    NEC_GUARD(
        m_context.gn_card(type, radialCount, epsR, sigmaSm, f3, f4, f5, f6);)
  }

  void frequency(double freqMhz) {
    // Linear stepping, one step: this package solves one frequency per run.
    NEC_GUARD(m_context.fr_card(0, 1, freqMhz, 0.0);)
  }

  // An applied-voltage source on one segment. kind selects EXCITATION_VOLTAGE
  // or EXCITATION_VOLTAGE_DISC (the current-slope-discontinuity form).
  void excitationVoltage(int kind, int tag, int segment, double vReal,
                         double vImag) {
    NEC_GUARD(m_context.ex_card(static_cast<excitation_type>(kind), tag,
                                segment, 0, vReal, vImag, 0.0, 0.0, 0.0, 0.0);)
  }

  // An elementary current source at a point in space, rather than on a
  // segment: position in metres, orientation as the angle down from z and the
  // azimuth, and the current moment.
  void excitationCurrent(double x, double y, double z, double alphaDeg,
                         double betaDeg, double moment) {
    NEC_GUARD(m_context.ex_card(EXCITATION_CURRENT, 0, 0, 0, x, y, z, alphaDeg,
                                betaDeg, moment);)
  }

  // An incident plane wave, which is how a receiving antenna or a radar cross
  // section is modelled. kind selects linear or either circular sense; the
  // angles sweep the arrival direction, and ratio is the axial ratio for the
  // elliptical case.
  void excitationPlaneWave(int kind, int nTheta, int nPhi, double thetaDeg,
                           double phiDeg, double etaDeg, double dThetaDeg,
                           double dPhiDeg, double ratio) {
    NEC_GUARD(m_context.ex_card(static_cast<excitation_type>(kind), nTheta,
                                nPhi, 0, thetaDeg, phiDeg, etaDeg, dThetaDeg,
                                dPhiDeg, ratio);)
  }

  // A two-port network between segments: the general form that a transmission
  // line is one case of. The six values are the admittance matrix entries.
  void network(int tag1, int segment1, int tag2, int segment2, double y11r,
               double y11i, double y12r, double y12i, double y22r,
               double y22i) {
    NEC_GUARD(m_context.nt_card(tag1, segment1, tag2, segment2, y11r, y11i,
                                y12r, y12i, y22r, y22i);)
  }

  // Below this separation, in wavelengths, NEC uses its cheaper interaction
  // approximation. The standard accuracy-for-speed knob on large structures.
  void interactionDistance(double wavelengths) {
    NEC_GUARD(m_context.kh_card(wavelengths);)
  }

  // The extended thin-wire kernel, for wires thick relative to their segment
  // length.
  void extendedThinWireKernel(bool enabled) {
    NEC_GUARD(m_context.set_extended_thin_wire_kernel(enabled);)
  }

  void loadCard(int type, int tag, int fromSegment, int toSegment, double f1,
                double f2, double f3) {
    NEC_GUARD(m_context.ld_card(type, tag, fromSegment, toSegment, f1, f2, f3);)
  }

  void transmissionLine(int tag1, int segment1, int tag2, int segment2,
                        double z0Ohm, double lengthM) {
    NEC_GUARD(m_context.tl_card(tag1, segment1, tag2, segment2, z0Ohm, lengthM,
                                0.0, 0.0, 0.0, 0.0);)
  }

  // --- solve ------------------------------------------------------------
  // Runs the solve. XNDA are the four RP option digits as separate values,
  // which is how nec2++ takes them -- there is no packed 1000-style code here.
  void radiationPattern(int calcMode, int nTheta, int nPhi, int x, int n, int d,
                        int a, double theta0Deg, double phi0Deg,
                        double dThetaDeg, double dPhiDeg) {
    NEC_GUARD(m_context.rp_card(calcMode, nTheta, nPhi, x, n, d, a, theta0Deg,
                                phi0Deg, dThetaDeg, dPhiDeg, 0.0, 0.0);)
    m_nTheta = nTheta;
    m_nPhi = nPhi;
  }

  // --- results ----------------------------------------------------------
  double impedanceReal(int feedIndex) {
    return m_context.get_impedance_real(0, feedIndex);
  }

  double impedanceImag(int feedIndex) {
    return m_context.get_impedance_imag(0, feedIndex);
  }

  GainStats gain() {
    return {m_context.get_gain_max(0), m_context.get_gain_min(0),
            m_context.get_gain_mean(0), m_context.get_gain_sd(0)};
  }

  GainStats gainRhcp() {
    return {m_context.get_gain_rhcp_max(0), m_context.get_gain_rhcp_min(0),
            m_context.get_gain_rhcp_mean(0), m_context.get_gain_rhcp_sd(0)};
  }

  GainStats gainLhcp() {
    return {m_context.get_gain_lhcp_max(0), m_context.get_gain_lhcp_min(0),
            m_context.get_gain_lhcp_mean(0), m_context.get_gain_lhcp_sd(0)};
  }

  // What each driven segment saw: impedance, the current that flowed, the
  // voltage applied and the power delivered.
  //
  // This is nec_antenna_input, not nec_structure_excitation. The latter is
  // built only inside netwk_compute_currents, so it exists only when the
  // model has an NT or TL network; antenna_input is the ordinary path and is
  // the one that always carries the feed data.
  std::vector<Feed> feeds() {
    nec_antenna_input* input = m_context.get_input_parameters(0);
    if (input == nullptr) {
      return {};
    }
    std::vector<int> tag = input->get_tag();
    std::vector<int> segment = input->get_segment();
    std::vector<nec_complex> current = input->get_current();
    std::vector<nec_complex> voltage = input->get_voltage();
    std::vector<nec_complex> impedance = input->get_impedance();
    std::vector<nec_float> power = input->get_power();

    std::vector<Feed> out;
    out.reserve(tag.size());
    for (size_t i = 0; i < tag.size(); i++) {
      Feed f;
      f.tag = tag[i];
      f.segment = i < segment.size() ? segment[i] : 0;
      f.iReal = i < current.size() ? real(current[i]) : 0.0;
      f.iImag = i < current.size() ? imag(current[i]) : 0.0;
      f.vReal = i < voltage.size() ? real(voltage[i]) : 0.0;
      f.vImag = i < voltage.size() ? imag(voltage[i]) : 0.0;
      f.zReal = i < impedance.size() ? real(impedance[i]) : 0.0;
      f.zImag = i < impedance.size() ? imag(impedance[i]) : 0.0;
      f.powerW = i < power.size() ? power[i] : 0.0;
      out.push_back(f);
    }
    return out;
  }

  // The honest efficiency figure over lossy ground, where a power budget
  // computed as input-minus-losses counts what the earth absorbs as radiated.
  // Only meaningful when the A digit asked for it and the grid has at least
  // two points in each angle.
  double averagePowerGain() {
    nec_radiation_pattern* rp = m_context.get_radiation_pattern(0);
    if (rp == nullptr) {
      throw std::runtime_error("no radiation pattern: run radiationPattern()");
    }
    return rp->get_average_power_gain();
  }

  std::vector<PatternPoint> pattern() {
    nec_radiation_pattern* rp = m_context.get_radiation_pattern(0);
    if (rp == nullptr) {
      throw std::runtime_error("no radiation pattern: run radiationPattern()");
    }
    std::vector<PatternPoint> points;
    points.reserve(static_cast<size_t>(m_nTheta) * m_nPhi);
    for (int phi = 0; phi < m_nPhi; phi++) {
      for (int theta = 0; theta < m_nTheta; theta++) {
        PatternPoint p;
        p.totalGainDb = rp->get_power_gain(theta, phi);
        p.axialRatio = rp->get_pol_axial_ratio(theta, phi);
        // Unlike axial ratio and sense, tilt has no indexed accessor; the
        // array it returns is indexed the same way.
        p.tiltDeg = rp->get_pol_tilt()(theta, phi);
        p.senseIndex = rp->get_pol_sense(theta, phi);
        p.eThetaMagnitude = rp->get_etheta_magnitude(theta, phi);
        p.eThetaPhaseDeg = rp->get_etheta_phase(theta, phi);
        p.ePhiMagnitude = rp->get_ephi_magnitude(theta, phi);
        p.ePhiPhaseDeg = rp->get_ephi_phase(theta, phi);
        points.push_back(p);
      }
    }
    return points;
  }

  std::vector<SegmentCurrent> currents() {
    nec_structure_currents* sc = m_context.get_structure_currents(0);
    if (sc == nullptr) {
      return {};
    }
    std::vector<int> segment = sc->get_current_segment_number();
    std::vector<int> tag = sc->get_current_segment_tag();
    std::vector<nec_float> x = sc->get_current_segment_center_x();
    std::vector<nec_float> y = sc->get_current_segment_center_y();
    std::vector<nec_float> z = sc->get_current_segment_center_z();
    std::vector<nec_float> length = sc->get_current_segment_length();
    std::vector<nec_complex> current = sc->get_current();

    std::vector<SegmentCurrent> out;
    out.reserve(current.size());
    for (size_t i = 0; i < current.size(); i++) {
      SegmentCurrent c;
      c.segment = i < segment.size() ? segment[i] : 0;
      c.tag = i < tag.size() ? tag[i] : 0;
      c.x = i < x.size() ? x[i] : 0.0;
      c.y = i < y.size() ? y[i] : 0.0;
      c.z = i < z.size() ? z[i] : 0.0;
      c.lengthM = i < length.size() ? length[i] : 0.0;
      c.iReal = real(current[i]);
      c.iImag = imag(current[i]);
      out.push_back(c);
    }
    return out;
  }

 private:
  nec_context m_context;
  // rp_card does not record the grid it was given, and the getters are indexed
  // rather than iterable, so the shape has to be remembered to walk them.
  int m_nTheta = 0;
  int m_nPhi = 0;
};

}  // namespace

EMSCRIPTEN_BINDINGS(nec2pp) {
  emscripten::value_object<PatternPoint>("PatternPoint")
      .field("totalGainDb", &PatternPoint::totalGainDb)
      .field("axialRatio", &PatternPoint::axialRatio)
      .field("tiltDeg", &PatternPoint::tiltDeg)
      .field("senseIndex", &PatternPoint::senseIndex)
      .field("eThetaMagnitude", &PatternPoint::eThetaMagnitude)
      .field("eThetaPhaseDeg", &PatternPoint::eThetaPhaseDeg)
      .field("ePhiMagnitude", &PatternPoint::ePhiMagnitude)
      .field("ePhiPhaseDeg", &PatternPoint::ePhiPhaseDeg);

  emscripten::value_object<SegmentCurrent>("SegmentCurrent")
      .field("tag", &SegmentCurrent::tag)
      .field("segment", &SegmentCurrent::segment)
      .field("x", &SegmentCurrent::x)
      .field("y", &SegmentCurrent::y)
      .field("z", &SegmentCurrent::z)
      .field("lengthM", &SegmentCurrent::lengthM)
      .field("iReal", &SegmentCurrent::iReal)
      .field("iImag", &SegmentCurrent::iImag);

  emscripten::value_object<Feed>("Feed")
      .field("tag", &Feed::tag)
      .field("segment", &Feed::segment)
      .field("zReal", &Feed::zReal)
      .field("zImag", &Feed::zImag)
      .field("iReal", &Feed::iReal)
      .field("iImag", &Feed::iImag)
      .field("vReal", &Feed::vReal)
      .field("vImag", &Feed::vImag)
      .field("powerW", &Feed::powerW);

  emscripten::value_object<GainStats>("GainStats")
      .field("maxDb", &GainStats::maxDb)
      .field("minDb", &GainStats::minDb)
      .field("meanDb", &GainStats::meanDb)
      .field("sdDb", &GainStats::sdDb);

  emscripten::register_vector<PatternPoint>("PatternPointVector");
  emscripten::register_vector<SegmentCurrent>("SegmentCurrentVector");
  emscripten::register_vector<Feed>("FeedVector");

  emscripten::class_<Nec>("Nec")
      .constructor<>()
      .function("wire", &Nec::wire)
      .function("arc", &Nec::arc)
      .function("helix", &Nec::helix)
      .function("reflect", &Nec::reflect)
      .function("transform", &Nec::transform)
      .function("geometryComplete", &Nec::geometryComplete)
      .function("groundCard", &Nec::groundCard)
      .function("frequency", &Nec::frequency)
      .function("excitationVoltage", &Nec::excitationVoltage)
      .function("excitationCurrent", &Nec::excitationCurrent)
      .function("excitationPlaneWave", &Nec::excitationPlaneWave)
      .function("loadCard", &Nec::loadCard)
      .function("transmissionLine", &Nec::transmissionLine)
      .function("network", &Nec::network)
      .function("interactionDistance", &Nec::interactionDistance)
      .function("extendedThinWireKernel", &Nec::extendedThinWireKernel)
      .function("radiationPattern", &Nec::radiationPattern)
      .function("impedanceReal", &Nec::impedanceReal)
      .function("impedanceImag", &Nec::impedanceImag)
      .function("gain", &Nec::gain)
      .function("gainRhcp", &Nec::gainRhcp)
      .function("gainLhcp", &Nec::gainLhcp)
      .function("averagePowerGain", &Nec::averagePowerGain)
      .function("feeds", &Nec::feeds)
      .function("pattern", &Nec::pattern)
      .function("currents", &Nec::currents);
}
