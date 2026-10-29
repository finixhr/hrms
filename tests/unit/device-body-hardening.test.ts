/// <reference types="bun-types" />
// ============ H-12/H-13 regression: device body caps + punch-photo traversal ============
// ATTLOG/OPTION endpoints cap bodies at 256 KB, photos at 2 MB — enforced
// BEFORE the body is read. The punch-photo `pin` parameter is validated
// (traversal payloads rejected 400), photo paths stay inside the root, and
// only real JPEG/PNG magic-byte images persist.
import path from "node:path"
import { describe, test, expect } from "bun:test"
import { isValidPhotoPin, punchPhotoDir, isImageMagic, PHOTO_PIN_RE } from "@/hrm-server/zkteco/adapter"
import { bodyCapExceeded, BODY_CAP_ATTLOG, BODY_CAP_PHOTO } from "@/hrm-server/zkteco/gateway"

const reqWithCL = (cl: string | null) => ({ headers: { get: (name: string) => (name === "content-length" ? cl : null) } })

describe("H-12 bodyCapExceeded", () => {
  test("ATTLOG cap: 256 KB", () => {
    expect(BODY_CAP_ATTLOG).toBe(256 * 1024)
    expect(bodyCapExceeded(reqWithCL(String(256 * 1024)), BODY_CAP_ATTLOG)).toBe(false)
    expect(bodyCapExceeded(reqWithCL(String(256 * 1024 + 1)), BODY_CAP_ATTLOG)).toBe(true)
  })
  test("photo cap: 2 MB", () => {
    expect(BODY_CAP_PHOTO).toBe(2 * 1024 * 1024)
    expect(bodyCapExceeded(reqWithCL(String(2 * 1024 * 1024)), BODY_CAP_PHOTO)).toBe(false)
    expect(bodyCapExceeded(reqWithCL(String(2 * 1024 * 1024 + 1)), BODY_CAP_PHOTO)).toBe(true)
  })
  test("missing Content-Length is rejected without reading the body", () => {
    expect(bodyCapExceeded(reqWithCL(null), BODY_CAP_ATTLOG)).toBe(true)
    expect(bodyCapExceeded(reqWithCL(""), BODY_CAP_ATTLOG)).toBe(true)
    expect(bodyCapExceeded(reqWithCL("garbage"), BODY_CAP_ATTLOG)).toBe(true)
    expect(bodyCapExceeded(reqWithCL("0"), BODY_CAP_ATTLOG)).toBe(true)
  })
})

describe("H-13 isValidPhotoPin — traversal payloads all rejected", () => {
  const hostile = [
    "../../../etc/passwd",
    "..",
    "../",
    "..\\..\\windows",
    "/etc/passwd",           // absolute path
    "C:\\windows\\system32", // windows absolute
    "%2e%2e%2f",             // URL-encoded ../ (decoded by searchParams.get)
    "%2e%2e/",
    "a/b",
    "a\\b",
    "a b",                   // space — not in the allowed set
    "pin;rm -rf /",
    "$(whoami)",
    "你好",                     // unicode
    "",                      // empty
    "x".repeat(33),          // too long
  ]
  for (const pin of hostile) {
    test(`rejects: ${JSON.stringify(pin)}`, () => {
      expect(isValidPhotoPin(pin)).toBe(false)
    })
  }
  test("accepts legitimate pins", () => {
    for (const pin of ["1001", "1234567890", "user_42", "pin-1", "A9z-_"]) {
      expect(isValidPhotoPin(pin)).toBe(true)
    }
  })
  test("the regex cannot match any path separator or dot", () => {
    expect(PHOTO_PIN_RE.source).not.toContain(".")
    // property-style: no accepted value can contain / \ . % $ ( ) space
    for (const c of ["/", "\\", ".", "%", "$", "(", ")", " "]) {
      expect(isValidPhotoPin("a" + c + "b")).toBe(false)
    }
  })
})

describe("H-13 punchPhotoDir — path containment", () => {
  const ROOT = path.resolve("srv", "hrm", "storage", "punch-photos")
  test("valid SN resolves to a directory inside the root", () => {
    const dir = punchPhotoDir(ROOT, "AABBCC123456")
    expect(dir).toBeTruthy()
    expect(dir!.startsWith(ROOT)).toBe(true)
  })
  test("traversal SNs are rejected", () => {
    expect(punchPhotoDir(ROOT, "../../../etc")).toBeNull()
    expect(punchPhotoDir(ROOT, "..")).toBeNull()
    expect(punchPhotoDir(ROOT, "sub/../../..")).toBeNull()
    expect(punchPhotoDir(ROOT, "/absolute/path")).toBeNull()
    expect(punchPhotoDir(ROOT, "a b")).toBeNull()
  })
})

describe("H-13 isImageMagic", () => {
  test("JPEG magic bytes pass", () => {
    expect(isImageMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe(true)
  })
  test("PNG magic bytes pass", () => {
    expect(isImageMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(true)
  })
  test("non-image payloads are rejected", () => {
    expect(isImageMagic(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBe(false) // "<svg"
    expect(isImageMagic(Buffer.from("<?php system($_GET[0]); ?>"))).toBe(false)
    expect(isImageMagic(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBe(false)
    expect(isImageMagic(new Uint8Array())).toBe(false)
    expect(isImageMagic(new Uint8Array([0xff, 0xd8]))).toBe(false) // too short
  })
})
