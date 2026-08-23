import AppKit
import CoreGraphics
import Foundation

// TeaBranch app icon generator — three candidate designs, one renderer.
//
// Shared rules, which are what actually make an icon look "glossy" rather than merely shiny:
//   - one light direction (upper-left) obeyed by every element,
//   - a sheen that is a *gradient*, never a clipped shape, so it has no seam,
//   - a lit top rim and a dark bottom rim, which is what gives the tile thickness,
//   - and few enough elements that the silhouette still reads at 16pt.

// MARK: - Shared geometry

/// Apple's icon corner is a superellipse, not a rounded rectangle: the curvature is continuous, so
/// there is no visible seam where the straight edge meets the arc.
func squirclePath(in rect: CGRect, exponent: Double = 5.0, samples: Int = 720) -> CGPath {
    let path = CGMutablePath()
    let a = Double(rect.width / 2), b = Double(rect.height / 2)
    let cx = Double(rect.midX), cy = Double(rect.midY)
    for i in 0...samples {
        let t = Double(i) / Double(samples) * 2 * .pi
        let ct = cos(t), st = sin(t)
        let x = cx + a * copysign(pow(abs(ct), 2.0 / exponent), ct)
        let y = cy + b * copysign(pow(abs(st), 2.0 / exponent), st)
        if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
    }
    path.closeSubpath()
    return path
}

let space = CGColorSpaceCreateDeviceRGB()

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha)
}

func gradient(_ stops: [(CGFloat, CGColor)]) -> CGGradient {
    CGGradient(colorsSpace: space, colors: stops.map { $0.1 } as CFArray, locations: stops.map { $0.0 })!
}

func blend(_ a: CGColor, _ b: CGColor, _ t: CGFloat) -> CGColor {
    let ca = a.components ?? [0, 0, 0, 1], cb = b.components ?? [0, 0, 0, 1]
    return CGColor(srgbRed: ca[0] + (cb[0] - ca[0]) * t,
                   green: ca[1] + (cb[1] - ca[1]) * t,
                   blue: ca[2] + (cb[2] - ca[2]) * t,
                   alpha: ca[3] + (cb[3] - ca[3]) * t)
}

// MARK: - Palette

let baseTop    = rgb(0x2E3566)
let baseMid    = rgb(0x191D3D)
let baseBottom = rgb(0x0A0C1C)
let accent     = rgb(0x5B8DEF)
let accentLit  = rgb(0x9CC0FF)
let leafGreen  = rgb(0x4FC98A)
let leafLit    = rgb(0x9BF0C4)
let white      = rgb(0xFFFFFF)
let softWhite  = rgb(0xDCE5FA)
let shadeBlue  = rgb(0x5A6796)

// MARK: - Shared passes

func drawTile(_ tile: CGRect, shape: CGPath, size: CGFloat, tiny: Bool, in context: CGContext) {
    let s = size / 1024

    context.saveGState()
    context.addPath(shape)
    context.setShadow(offset: CGSize(width: 0, height: -size * 0.012),
                      blur: size * 0.045, color: rgb(0x000000, 0.55))
    context.setFillColor(baseBottom)
    context.fillPath()
    context.restoreGState()

    context.saveGState()
    context.addPath(shape)
    context.clip()
    context.drawLinearGradient(
        gradient([(0, baseTop), (0.42, baseMid), (1, baseBottom)]),
        start: CGPoint(x: tile.midX, y: tile.maxY),
        end: CGPoint(x: tile.midX, y: tile.minY),
        options: []
    )
    // The sheen. A plain top-down gradient reaching zero well before it runs out — the earlier
    // version clipped a bright ellipse, and you could see the ellipse.
    if !tiny {
        context.drawLinearGradient(
            gradient([(0, rgb(0xFFFFFF, 0.16)), (0.35, rgb(0xFFFFFF, 0.045)), (0.62, rgb(0xFFFFFF, 0))]),
            start: CGPoint(x: tile.midX, y: tile.maxY),
            end: CGPoint(x: tile.midX, y: tile.minY),
            options: []
        )
    }
    context.restoreGState()
    _ = s
}

func drawRim(_ tile: CGRect, shape: CGPath, size: CGFloat, in context: CGContext) {
    let s = size / 1024
    context.saveGState()
    context.addPath(shape)
    context.clip()
    context.addPath(shape)
    context.setLineWidth(max(1, 3 * s) * 2)
    context.replacePathWithStrokedPath()
    context.clip()
    context.drawLinearGradient(
        gradient([(0, rgb(0xFFFFFF, 0.55)), (0.32, rgb(0xFFFFFF, 0.10)),
                  (0.72, rgb(0x000000, 0.10)), (1, rgb(0x000000, 0.32))]),
        start: CGPoint(x: tile.midX, y: tile.maxY),
        end: CGPoint(x: tile.midX, y: tile.minY),
        options: []
    )
    context.restoreGState()
}

/// A lit sphere: body gradient offset toward the light, a specular dot, a contact shadow.
func drawSphere(at centre: CGPoint, radius: CGFloat, body: CGColor, shade: CGColor,
                detailed: Bool, in context: CGContext) {
    let box = CGRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2)

    if detailed {
        context.saveGState()
        context.setShadow(offset: CGSize(width: 0, height: -radius * 0.20),
                          blur: radius * 0.5, color: rgb(0x05070F, 0.55))
        context.setFillColor(shade)
        context.fillEllipse(in: box)
        context.restoreGState()
    }

    context.saveGState()
    context.addEllipse(in: box)
    context.clip()
    context.drawRadialGradient(
        gradient([(0, blend(white, body, 0.25)), (0.5, body), (1, blend(body, shade, 0.9))]),
        startCenter: CGPoint(x: centre.x - radius * 0.34, y: centre.y + radius * 0.34),
        startRadius: 0,
        endCenter: centre, endRadius: radius * 1.3,
        options: [.drawsAfterEndLocation]
    )
    context.restoreGState()

    guard detailed else { return }
    context.saveGState()
    let spec = CGRect(x: centre.x - radius * 0.58, y: centre.y + radius * 0.12,
                      width: radius * 0.68, height: radius * 0.46)
    context.addEllipse(in: spec)
    context.clip()
    context.drawRadialGradient(
        gradient([(0, rgb(0xFFFFFF, 0.92)), (1, rgb(0xFFFFFF, 0))]),
        startCenter: CGPoint(x: spec.midX, y: spec.midY), startRadius: 0,
        endCenter: CGPoint(x: spec.midX, y: spec.midY), endRadius: spec.width / 2,
        options: []
    )
    context.restoreGState()
}

/// A stroked path drawn as a lit tube: dark base, gradient body, bright top edge.
func drawTube(_ path: CGPath, width: CGFloat, body: CGColor, tile: CGRect,
              detailed: Bool, in context: CGContext) {
    context.saveGState()
    if detailed {
        context.setShadow(offset: CGSize(width: 0, height: -width * 0.22),
                          blur: width * 0.6, color: rgb(0x05070F, 0.5))
    }
    context.addPath(path)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    context.setLineWidth(width)
    context.setStrokeColor(blend(body, rgb(0x0A0C1C), 0.35))
    context.strokePath()
    context.restoreGState()

    context.saveGState()
    context.addPath(path)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    context.setLineWidth(width)
    context.replacePathWithStrokedPath()
    context.clip()
    context.drawLinearGradient(
        gradient([(0, blend(white, body, 0.35)), (0.45, body), (1, blend(body, rgb(0x1A1E3C), 0.7))]),
        start: CGPoint(x: tile.midX, y: tile.maxY),
        end: CGPoint(x: tile.midX, y: tile.minY),
        options: []
    )
    context.restoreGState()
}

// MARK: - Design A · git branch

/// The universal git-branch glyph: a trunk, one branch leaving it, a node at each terminus.
/// It says exactly what the app does, and three elements survive 16pt.
func drawBranchGlyph(_ tile: CGRect, size: CGFloat, in context: CGContext) {
    let detailed = size >= 64
    let w = tile.width
    let stroke = w * 0.085
    let r = w * 0.105

    let trunkX = tile.minX + w * 0.34
    let bottom = CGPoint(x: trunkX, y: tile.minY + w * 0.20)
    let top = CGPoint(x: trunkX, y: tile.maxY - w * 0.20)
    let branchEnd = CGPoint(x: tile.minX + w * 0.70, y: tile.maxY - w * 0.30)

    let trunk = CGMutablePath()
    trunk.move(to: bottom)
    trunk.addLine(to: top)
    drawTube(trunk, width: stroke, body: softWhite, tile: tile, detailed: detailed, in: context)

    // The branch leaves the trunk on a curve — a right angle would read as a circuit diagram.
    let branch = CGMutablePath()
    let fork = CGPoint(x: trunkX, y: tile.minY + w * 0.44)
    branch.move(to: fork)
    branch.addCurve(
        to: branchEnd,
        control1: CGPoint(x: trunkX, y: fork.y + w * 0.22),
        control2: CGPoint(x: branchEnd.x, y: branchEnd.y - w * 0.24)
    )
    drawTube(branch, width: stroke, body: accent, tile: tile, detailed: detailed, in: context)

    drawSphere(at: bottom, radius: r, body: softWhite, shade: shadeBlue, detailed: detailed, in: context)
    drawSphere(at: top, radius: r, body: white, shade: shadeBlue, detailed: detailed, in: context)
    drawSphere(at: branchEnd, radius: r, body: accentLit, shade: accent, detailed: detailed, in: context)
}

// MARK: - Design B · parallel lanes

/// Three lanes running at once — the thing the app is *for*, stated as plainly as possible.
/// The tallest is the one that's live, so the icon has a subject.
func drawLanesGlyph(_ tile: CGRect, size: CGFloat, in context: CGContext) {
    let detailed = size >= 64
    let w = tile.width
    let barWidth = w * 0.135
    let gap = w * 0.115
    let totalWidth = barWidth * 3 + gap * 2
    let startX = tile.midX - totalWidth / 2 + barWidth / 2
    let baseY = tile.minY + w * 0.22

    let heights: [CGFloat] = [0.34, 0.56, 0.44]
    let colors: [CGColor] = [softWhite, accentLit, softWhite]
    let shades: [CGColor] = [shadeBlue, accent, shadeBlue]

    for i in 0..<3 {
        let x = startX + CGFloat(i) * (barWidth + gap)
        let path = CGMutablePath()
        path.move(to: CGPoint(x: x, y: baseY))
        path.addLine(to: CGPoint(x: x, y: baseY + w * heights[i]))
        drawTube(path, width: barWidth, body: colors[i], tile: tile, detailed: detailed, in: context)

        // A cap sphere turns a bar into an object with a top.
        drawSphere(at: CGPoint(x: x, y: baseY + w * heights[i]), radius: barWidth * 0.5,
                   body: colors[i], shade: shades[i], detailed: detailed, in: context)
    }
}

// MARK: - Design C · leaf on a branch

/// The name, drawn: a stem that forks, with a tea leaf on the branch that took off.
func drawLeafGlyph(_ tile: CGRect, size: CGFloat, in context: CGContext) {
    let detailed = size >= 64
    let w = tile.width
    let stroke = w * 0.075

    let bottom = CGPoint(x: tile.minX + w * 0.32, y: tile.minY + w * 0.18)
    let top = CGPoint(x: tile.minX + w * 0.32, y: tile.maxY - w * 0.26)

    let stem = CGMutablePath()
    stem.move(to: bottom)
    stem.addLine(to: top)
    drawTube(stem, width: stroke, body: softWhite, tile: tile, detailed: detailed, in: context)

    let fork = CGPoint(x: bottom.x, y: tile.minY + w * 0.42)
    let leafBase = CGPoint(x: tile.minX + w * 0.60, y: tile.midY + w * 0.02)
    let branch = CGMutablePath()
    branch.move(to: fork)
    branch.addCurve(to: leafBase,
                    control1: CGPoint(x: fork.x, y: fork.y + w * 0.18),
                    control2: CGPoint(x: leafBase.x - w * 0.10, y: leafBase.y - w * 0.14))
    drawTube(branch, width: stroke, body: leafGreen, tile: tile, detailed: detailed, in: context)

    // The leaf: two mirrored curves meeting at a tip.
    let tip = CGPoint(x: tile.minX + w * 0.84, y: tile.maxY - w * 0.22)
    let leaf = CGMutablePath()
    leaf.move(to: leafBase)
    leaf.addCurve(to: tip,
                  control1: CGPoint(x: leafBase.x + w * 0.02, y: leafBase.y + w * 0.20),
                  control2: CGPoint(x: tip.x - w * 0.16, y: tip.y + w * 0.02))
    leaf.addCurve(to: leafBase,
                  control1: CGPoint(x: tip.x - w * 0.02, y: tip.y - w * 0.18),
                  control2: CGPoint(x: leafBase.x + w * 0.20, y: leafBase.y - w * 0.02))
    leaf.closeSubpath()

    context.saveGState()
    if detailed {
        context.setShadow(offset: CGSize(width: 0, height: -w * 0.018),
                          blur: w * 0.05, color: rgb(0x05070F, 0.5))
    }
    context.addPath(leaf)
    context.setFillColor(leafGreen)
    context.fillPath()
    context.restoreGState()

    context.saveGState()
    context.addPath(leaf)
    context.clip()
    context.drawLinearGradient(
        gradient([(0, leafLit), (0.55, leafGreen), (1, blend(leafGreen, rgb(0x0A2E1E), 0.75))]),
        start: CGPoint(x: tile.midX, y: tile.maxY),
        end: CGPoint(x: tile.midX, y: tile.midY - w * 0.10),
        options: []
    )
    context.restoreGState()

    // Midrib, so the leaf reads as a leaf and not as a petal.
    if detailed {
        let rib = CGMutablePath()
        rib.move(to: leafBase)
        rib.addCurve(to: tip,
                     control1: CGPoint(x: leafBase.x + w * 0.14, y: leafBase.y + w * 0.03),
                     control2: CGPoint(x: tip.x - w * 0.12, y: tip.y - w * 0.06))
        context.saveGState()
        context.addPath(rib)
        context.setLineCap(.round)
        context.setLineWidth(w * 0.016)
        context.setStrokeColor(rgb(0x0A2E1E, 0.45))
        context.strokePath()
        context.restoreGState()
    }

    drawSphere(at: bottom, radius: w * 0.088, body: softWhite, shade: shadeBlue,
               detailed: detailed, in: context)
    drawSphere(at: top, radius: w * 0.088, body: white, shade: shadeBlue,
               detailed: detailed, in: context)
}

// MARK: - Renderer

enum Design: String {
    case branch, lanes, leaf

    var glyph: (CGRect, CGFloat, CGContext) -> Void {
        switch self {
        case .branch: return drawBranchGlyph
        case .lanes: return drawLanesGlyph
        case .leaf: return drawLeafGlyph
        }
    }
}

func drawIcon(design: Design, size: CGFloat, into context: CGContext) {
    let rect = CGRect(x: 0, y: 0, width: size, height: size)
    let inset = size * 0.055
    let tile = rect.insetBy(dx: inset, dy: inset)
    let shape = squirclePath(in: tile)
    let tiny = size < 32

    drawTile(tile, shape: shape, size: size, tiny: tiny, in: context)

    context.saveGState()
    context.addPath(shape)
    context.clip()
    design.glyph(tile, size, context)
    context.restoreGState()

    drawRim(tile, shape: shape, size: size, in: context)
}

func render(design: Design, size: Int, to url: URL) throws {
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { fatalError("no context") }
    context.setAllowsAntialiasing(true)
    context.interpolationQuality = .high
    drawIcon(design: design, size: CGFloat(size), into: context)

    guard let image = context.makeImage() else { fatalError("no image") }
    let rep = NSBitmapImageRep(cgImage: image)
    rep.size = NSSize(width: size, height: size)
    guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("no png") }
    try data.write(to: url)
}

let variants: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

// A menu-bar template image: pure silhouette, no colour, no gloss. macOS tints it for the
// current appearance, so anything but alpha is discarded — the leaf and stem are drawn as one
// solid shape at the size the status item actually uses.
func renderTray(size: Int, to url: URL) throws {
    guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { fatalError("no context") }
    context.setAllowsAntialiasing(true)

    let w = CGFloat(size)
    let ink = rgb(0x000000)
    let stroke = w * 0.10

    let stemX = w * 0.30
    let bottom = CGPoint(x: stemX, y: w * 0.14)
    let top = CGPoint(x: stemX, y: w * 0.86)

    context.setLineCap(.round)
    context.setLineJoin(.round)
    context.setStrokeColor(ink)
    context.setFillColor(ink)

    context.setLineWidth(stroke)
    context.move(to: bottom)
    context.addLine(to: top)
    context.strokePath()

    let fork = CGPoint(x: stemX, y: w * 0.40)
    let leafBase = CGPoint(x: w * 0.58, y: w * 0.56)
    context.move(to: fork)
    context.addCurve(to: leafBase,
                     control1: CGPoint(x: fork.x, y: fork.y + w * 0.16),
                     control2: CGPoint(x: leafBase.x - w * 0.10, y: leafBase.y - w * 0.12))
    context.strokePath()

    let tip = CGPoint(x: w * 0.90, y: w * 0.86)
    context.move(to: leafBase)
    context.addCurve(to: tip,
                     control1: CGPoint(x: leafBase.x + w * 0.02, y: leafBase.y + w * 0.20),
                     control2: CGPoint(x: tip.x - w * 0.16, y: tip.y + w * 0.02))
    context.addCurve(to: leafBase,
                     control1: CGPoint(x: tip.x - w * 0.02, y: tip.y - w * 0.18),
                     control2: CGPoint(x: leafBase.x + w * 0.20, y: leafBase.y - w * 0.02))
    context.closePath()
    context.fillPath()

    // Terminal nodes, so the stem reads as a branch and not as a stick.
    for point in [bottom, top] {
        context.fillEllipse(in: CGRect(x: point.x - w * 0.11, y: point.y - w * 0.11,
                                       width: w * 0.22, height: w * 0.22))
    }

    guard let image = context.makeImage() else { fatalError("no image") }
    let rep = NSBitmapImageRep(cgImage: image)
    rep.size = NSSize(width: size, height: size)
    guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("no png") }
    try data.write(to: url)
}

if CommandLine.arguments[1] == "tray" {
    let out = URL(fileURLWithPath: CommandLine.arguments[2])
    try? FileManager.default.createDirectory(at: out.deletingLastPathComponent(),
                                             withIntermediateDirectories: true)
    try renderTray(size: 36, to: out)
    print("tray: done")
    exit(0)
}

let design = Design(rawValue: CommandLine.arguments[1])!
let outputDirectory = URL(fileURLWithPath: CommandLine.arguments[2])
try? FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

if CommandLine.arguments.count > 3, CommandLine.arguments[3] == "--preview" {
    // A contact sheet of the sizes that matter, for eyeballing before committing.
    for size in [512, 128, 64, 32, 16] {
        try render(design: design, size: size,
                   to: outputDirectory.appendingPathComponent("\(design.rawValue)-\(size).png"))
    }
} else {
    for (name, size) in variants {
        try render(design: design, size: size, to: outputDirectory.appendingPathComponent("\(name).png"))
    }
}
print("\(design.rawValue): done → \(outputDirectory.path)")
