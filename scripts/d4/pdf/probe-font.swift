// D4 PDF fixture generator — CoreText font-subset probe (macOS only, optional).
//
// Extracts a /FontFile2 stream from a generated fixture (see REPORT.md for
// the extraction one-liner) and asks CoreText to load the subset as a real
// font. Independent validation that the hand-built TTF subsets are
// structurally valid TrueType, beyond our own parser and Chrome's renderer.
//
// Usage: swift scripts/d4/pdf/probe-font.swift <subset.ttf>

import Foundation
import CoreText

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path) as CFURL
if let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url) as? [CTFontDescriptor], !descriptors.isEmpty {
  print("CoreText descriptors:", descriptors.count)
  for d in descriptors {
    let font = CTFontCreateWithFontDescriptor(d, 12.0, nil)
    let name = CTFontCopyPostScriptName(font) as String
    let glyphs = CTFontGetGlyphCount(font)
    let upem = CTFontGetUnitsPerEm(font)
    print("loaded:", name, "glyphs:", glyphs, "upem:", upem)
  }
} else {
  print("CoreText returned no font descriptors (font rejected)")
  exit(1)
}
