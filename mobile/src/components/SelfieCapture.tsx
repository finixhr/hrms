// ============ Selfie attendance capture (M3 / T-13) ============
//
// Native front-camera capture flow for selfie punches:
//   permission request → live preview with framing guide → capture →
//   downscale ≤640px JPEG → CONFIRM or RETAKE → resolve for the caller.
//
// DESIGN RULES (directive M3-B):
//   · the photo is ONLY taken when the user taps the shutter, and ONLY
//     submitted after an explicit Confirm — opening this sheet never
//     uploads anything;
//   · the full-resolution frame is downscaled immediately via
//     expo-image-manipulator (resize 640 + JPEG compress 0.7 + base64 in
//     one step) so no full-res buffer leaves the capture pipeline —
//     matching the web portal's ≤640px JPEG contract (S.selfieCheckin
//     selfieDataUrl max 2.5MB);
//   · quality metadata is honest evidence only: width/height/approx bytes.
//     NO face detection, NO liveness, NO biometric claims — a selfie is
//     proof of presence, not identity verification (§27). The server stores
//     the metadata on the proof row for human reviewers, nothing more;
//   · camera permission denial gets an actionable message, never a crash.
//
// ONLINE-ONLY by design: selfie photos are sensitive personal data and are
// deliberately NOT queued in the offline outbox (no local photo storage, no
// encryption key management on device, and an hours-late selfie has weak
// evidentiary value). The caller checks connectivity first and explains.

import { useCallback, useEffect, useRef, useState } from "react"
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ActivityIndicator,
  Platform, Image, Dimensions, Alert,
} from "react-native"
import { CameraView, useCameraPermissions } from "expo-camera"
import { manipulateAsync, SaveFormat } from "expo-image-manipulator"
import { Ionicons } from "@expo/vector-icons"
import { Colors, Spacing, Typography, Radius } from "@/src/theme"

export interface SelfieShot {
  /** data:image/jpeg;base64,… — ≤640px, ready for selfieDataUrl */
  dataUrl: string
  /** Honest provenance metadata — evidence only, never identity claims */
  quality: {
    method: string
    width: number
    height: number
    bytesApprox: number
    capturedAt: string
  }
}

interface SelfieCaptureProps {
  visible: boolean
  title: string
  hint: string
  onCancel: () => void
  onConfirmed: (shot: SelfieShot) => void
}

export function SelfieCapture({ visible, title, hint, onCancel, onConfirmed }: SelfieCaptureProps) {
  const [permission, requestPermission] = useCameraPermissions()
  const cameraRef = useRef<CameraView | null>(null)
  const [captured, setCaptured] = useState<SelfieShot | null>(null)
  const [shooting, setShooting] = useState(false)

  // Reset the sheet state each time it opens — a previous capture never
  // leaks into a new session
  useEffect(() => {
    if (visible) setCaptured(null)
  }, [visible])

  const takeShot = useCallback(async () => {
    const camera = cameraRef.current
    if (!camera || shooting) return
    setShooting(true)
    try {
      const shot = await camera.takePictureAsync({ quality: 0.8, exif: false })
      if (!shot?.uri) {
        Alert.alert("Capture Failed", "The camera did not return an image. Please try again.")
        return
      }
      // Downscale + compress + base64 in ONE native pass — the ≤640px JPEG
      // data-URL contract the server's selfie schema expects. Nothing at
      // full resolution is kept or transmitted.
      const small = await manipulateAsync(
        shot.uri,
        [{ resize: { width: 640 } }],
        { compress: 0.7, format: SaveFormat.JPEG, base64: true },
      )
      if (!small.base64) {
        Alert.alert("Capture Failed", "Could not process the photo. Please try again.")
        return
      }
      setCaptured({
        dataUrl: `data:image/jpeg;base64,${small.base64}`,
        quality: {
          method: "NATIVE_CAMERA",
          width: small.width,
          height: small.height,
          bytesApprox: Math.round((small.base64.length * 3) / 4),
          capturedAt: new Date().toISOString(),
        },
      })
    } catch {
      Alert.alert("Capture Failed", "Could not take the photo. Please try again.")
    } finally {
      setShooting(false)
    }
  }, [shooting])

  // ---- permission states (before any camera mounts) ----------------------
  if (!permission) {
    return (
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
        <View style={styles.centerWrap}><ActivityIndicator color="#fff" /></View>
      </Modal>
    )
  }
  if (!permission.granted && visible) {
    return (
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
        <View style={styles.centerWrap}>
          <View style={styles.permissionCard}>
            <Ionicons name="camera-outline" size={44} color={Colors.primary} />
            <Text style={[Typography.h3, { textAlign: "center", marginTop: Spacing.md }]}>Camera access needed</Text>
            <Text style={[Typography.bodyS, { textAlign: "center", marginTop: Spacing.sm, color: Colors.textSecondary }]}>
              Selfie attendance takes a photo with your front camera as proof of presence. The photo is
              sent securely to your HR system and is never stored on your phone.
            </Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => { requestPermission() }}>
              <Text style={styles.primaryBtnText}>Allow Camera Access</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.linkBtn} onPress={onCancel}>
              <Text style={styles.linkBtnText}>Cancel</Text>
            </TouchableOpacity>
            {permission.canAskAgain === false && (
              <Text style={[Typography.caption, { textAlign: "center", marginTop: Spacing.md, color: Colors.warning }]}>
                Camera access was denied. Enable it in your device settings (long-press the app icon → App Info → Permissions).
              </Text>
            )}
          </View>
        </View>
      </Modal>
    )
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.sheet}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} accessibilityLabel="Cancel selfie" accessibilityRole="button">
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{title}</Text>
          <View style={{ width: 26 }} />
        </View>
        <Text style={styles.headerHint}>{hint}</Text>

        {/* Stage: live preview with framing guide, or the captured photo awaiting confirmation */}
        <View style={styles.stage}>
          {captured ? (
            <View style={styles.previewWrap}>
              {/* React Native Image exposes accessibility via
                  accessibilityLabel (set below) — web-DOM `alt` semantics
                  don't apply. (An a11y lint directive used to sit here
                  referencing a rule no mobile config defines; it would break
                  the now-working lint run.) */}
              <Image
                source={{ uri: captured.dataUrl }}
                style={styles.previewImg}
                resizeMode="cover"
                accessibilityLabel="Preview of your captured selfie"
                accessible
              />
              <View style={styles.confirmBanner}>
                <Ionicons name="help-circle-outline" size={16} color="#fff" />
                <Text style={styles.confirmBannerText}>Look right? Confirm to submit — or retake.</Text>
              </View>
            </View>
          ) : (
            <CameraView
              ref={cameraRef}
              style={styles.camera}
              facing="front"
              mirror
            >
              {/* Framing guide: circle + hint — guidance only, no face detection */}
              <View style={styles.guideWrap} pointerEvents="none">
                <View style={styles.guideCircle} />
                <Text style={styles.guideText}>Hold the phone at eye level · face inside the circle</Text>
              </View>
            </CameraView>
          )}
        </View>

        {/* Controls */}
        <View style={styles.controls}>
          {captured ? (
            <View style={styles.rowBtns}>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => setCaptured(null)}
                accessibilityLabel="Retake selfie" accessibilityRole="button"
              >
                <Ionicons name="refresh-outline" size={20} color={Colors.primary} />
                <Text style={styles.secondaryBtnText}>Retake</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.primaryBtn2}
                onPress={() => onConfirmed(captured)}
                accessibilityLabel="Confirm and submit selfie" accessibilityRole="button"
              >
                <Ionicons name="checkmark" size={20} color="#fff" />
                <Text style={styles.primaryBtnText}>Confirm &amp; Submit</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.shutter, shooting && { opacity: 0.5 }]}
              disabled={shooting}
              onPress={takeShot}
              accessibilityLabel="Take selfie" accessibilityRole="button"
            >
              {shooting ? <ActivityIndicator color="#fff" /> : <View style={styles.shutterInner} />}
            </TouchableOpacity>
          )}
        </View>

        {/* Privacy note — always visible while the sheet is open */}
        <Text style={styles.privacyNote}>
          Your selfie is transmitted over an authenticated connection and stored privately — visible
          only to authorized HR reviewers of your company, never through public links.
        </Text>
      </View>
    </Modal>
  )
}

const CIRCLE_D = Math.min(Dimensions.get("window").width * 0.62, 280)

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: "#0B1220", paddingTop: Platform.OS === "ios" ? 56 : 24 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: Spacing.lg },
  headerTitle: { color: "#fff", fontSize: 17, fontWeight: "800" },
  headerHint: { color: "rgba(255,255,255,0.65)", fontSize: 12, textAlign: "center", marginTop: Spacing.sm, paddingHorizontal: Spacing.xl },
  stage: { flex: 1, margin: Spacing.lg, borderRadius: Radius.lg, overflow: "hidden", backgroundColor: "#000" },
  camera: { flex: 1 },
  guideWrap: { ...StyleSheet.absoluteFillObject, justifyContent: "center", alignItems: "center" },
  guideCircle: {
    width: CIRCLE_D, height: CIRCLE_D, borderRadius: CIRCLE_D / 2,
    borderWidth: 2, borderColor: "rgba(255,255,255,0.55)",
  },
  guideText: { color: "rgba(255,255,255,0.8)", fontSize: 11, marginTop: Spacing.md, textAlign: "center", paddingHorizontal: Spacing.lg },
  previewWrap: { flex: 1 },
  previewImg: { flex: 1 },
  confirmBanner: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)", paddingVertical: 8, paddingHorizontal: 12,
  },
  confirmBannerText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  controls: { paddingBottom: Spacing.xl, paddingHorizontal: Spacing.lg },
  shutter: {
    alignSelf: "center", width: 74, height: 74, borderRadius: 37,
    backgroundColor: "#fff", justifyContent: "center", alignItems: "center",
    borderWidth: 4, borderColor: "rgba(255,255,255,0.35)",
  },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: Colors.primary },
  rowBtns: { flexDirection: "row", gap: Spacing.md },
  secondaryBtn: {
    flex: 1, flexDirection: "row", gap: 8, justifyContent: "center", alignItems: "center",
    backgroundColor: "#fff", borderRadius: Radius.lg, paddingVertical: 14,
  },
  secondaryBtnText: { color: Colors.primary, fontWeight: "700", fontSize: 14 },
  primaryBtn2: {
    flex: 1, flexDirection: "row", gap: 8, justifyContent: "center", alignItems: "center",
    backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 14,
  },
  centerWrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.8)", justifyContent: "center", alignItems: "center" },
  permissionCard: {
    backgroundColor: "#fff", borderRadius: Radius.lg, padding: Spacing.xl,
    marginHorizontal: Spacing.xl, gap: Spacing.md,
  },
  primaryBtn: { backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 13, alignItems: "center", marginTop: Spacing.sm },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  linkBtn: { alignItems: "center", paddingVertical: 6 },
  linkBtnText: { color: Colors.textSecondary, fontWeight: "600", fontSize: 13 },
  privacyNote: {
    color: "rgba(255,255,255,0.5)", fontSize: 10, textAlign: "center",
    paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xl, lineHeight: 15,
  },
})
