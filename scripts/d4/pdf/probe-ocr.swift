// D4 PDF fixture generator — OCR render probe (macOS only, optional).
//
// Independent visual verification of the generated fixtures: renders a PDF
// page with Apple CoreGraphics (sips) and runs Vision OCR over it. Used to
// produce the evidence recorded in scripts/d4/pdf/REPORT.md; not part of the
// generator's self-checks (Chrome pixel-ink smoke is the portable check).
//
// Usage:
//   sips -s format png  <pdf> --out /tmp/page.png
//   sips -s format jpeg /tmp/page.png --out /tmp/page.jpg   # flatten alpha
//   swift scripts/d4/pdf/probe-ocr.swift /tmp/page.jpg

import Foundation
import Vision
import AppKit

let path = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("cannot load image")
  exit(1)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([request])
let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
