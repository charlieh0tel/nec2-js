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

  void excitationVoltage(int tag, int segment, double vReal, double vImag) {
    NEC_GUARD(m_context.ex_card(EXCITATION_VOLTAGE, tag, segment, 0, vReal,
                                vImag, 0.0, 0.0, 0.0, 0.0);)
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

  double gainMax() { return m_context.get_gain_max(0); }
  double gainMean() { return m_context.get_gain_mean(0); }

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

  emscripten::register_vector<PatternPoint>("PatternPointVector");
  emscripten::register_vector<SegmentCurrent>("SegmentCurrentVector");

  emscripten::class_<Nec>("Nec")
      .constructor<>()
      .function("wire", &Nec::wire)
      .function("transform", &Nec::transform)
      .function("geometryComplete", &Nec::geometryComplete)
      .function("groundCard", &Nec::groundCard)
      .function("frequency", &Nec::frequency)
      .function("excitationVoltage", &Nec::excitationVoltage)
      .function("loadCard", &Nec::loadCard)
      .function("transmissionLine", &Nec::transmissionLine)
      .function("radiationPattern", &Nec::radiationPattern)
      .function("impedanceReal", &Nec::impedanceReal)
      .function("impedanceImag", &Nec::impedanceImag)
      .function("gainMax", &Nec::gainMax)
      .function("gainMean", &Nec::gainMean)
      .function("averagePowerGain", &Nec::averagePowerGain)
      .function("pattern", &Nec::pattern)
      .function("currents", &Nec::currents);
}
