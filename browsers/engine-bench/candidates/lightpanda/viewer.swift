import AppKit
import Foundation

// Diagnostic viewer only: upstream PNG is text-only, not CSS page rendering.
actor ProtocolClient {
    let task: URLSessionWebSocketTask
    var next = 0
    init(_ endpoint: String) { task = URLSession.shared.webSocketTask(with: URL(string: endpoint)!); task.resume() }
    func send(_ method: String, _ params: [String: Any] = [:], _ session: String? = nil) async throws -> [String: Any] {
        next += 1
        var message: [String: Any] = ["id": next, "method": method, "params": params]
        if let session = session { message["sessionId"] = session }
        let id = next
        let data = try JSONSerialization.data(withJSONObject: message)
        try await task.send(.string(String(data: data, encoding: .utf8)!))
        while true {
            let received = try await task.receive()
            let bytes: Data
            switch received { case .string(let value): bytes = Data(value.utf8); case .data(let value): bytes = value; @unknown default: continue }
            guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], object["id"] as? Int == id else { continue }
            if let error = object["error"] { throw NSError(domain: "CDP", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(error)"]) }
            return object["result"] as? [String: Any] ?? [:]
        }
    }
}
final class ImageInput: NSImageView {
    var dispatchInput: ((String, [String: Any]) -> Void)?
    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        dispatchInput?("click", ["x": point.x, "y": point.y])
    }
    override func scrollWheel(with event: NSEvent) { dispatchInput?("wheel", ["x": 400, "y": 300, "deltaX": event.scrollingDeltaX, "deltaY": event.scrollingDeltaY]) }
    override func keyDown(with event: NSEvent) { if let text = event.characters { dispatchInput?("text", ["text": text]) } }
}
@MainActor final class Delegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let image = ImageInput(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
    var client: ProtocolClient!
    var session = ""
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 800, height: 600), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Lightpanda diagnostic TEXT preview — NOT CSS page rendering"
        image.imageScaling = .scaleNone
        window.contentView = image
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        image.dispatchInput = { method, params in Task { @MainActor in do {
            if method == "text" { _ = try await self.client.send("Input.insertText", params, self.session) }
            else if method == "wheel" { var p = params; p["type"] = "mouseWheel"; _ = try await self.client.send("Input.dispatchMouseEvent", p, self.session) }
            else { for type in ["mousePressed", "mouseReleased"] { var p = params; p["type"] = type; p["button"] = "left"; p["clickCount"] = 1; _ = try await self.client.send("Input.dispatchMouseEvent", p, self.session) } }
            try await self.refresh()
        } catch { print("input_error \(error)") } } }
        Task { @MainActor in do {
            self.client = ProtocolClient(CommandLine.arguments[1])
            let context = try await client.send("Target.createBrowserContext")
            let target = try await client.send("Target.createTarget", ["url": "about:blank", "browserContextId": context["browserContextId"]!])
            let attached = try await client.send("Target.attachToTarget", ["targetId": target["targetId"]!, "flatten": true])
            session = attached["sessionId"] as! String
            _ = try await client.send("Page.enable", [:], session)
            _ = try await client.send("Emulation.setDeviceMetricsOverride", ["width":800,"height":600,"deviceScaleFactor":1,"mobile":false], session)
            _ = try await client.send("Page.navigate", ["url": CommandLine.arguments[2]], session)
            try await Task.sleep(nanoseconds: 200_000_000)
            try await refresh()
            print("viewer_ready: AppKit NSImageView + CDP screenshot and coordinate input; text-only image")
            if CommandLine.arguments.count > 3 {
                if let representation = image.bitmapImageRepForCachingDisplay(in: image.bounds) {
                    image.cacheDisplay(in: image.bounds, to: representation)
                    if let png = representation.representation(using: .png, properties: [:]) { try png.write(to: URL(fileURLWithPath: CommandLine.arguments[3])) }
                }
                _ = try await client.send("Target.disposeBrowserContext", ["browserContextId":context["browserContextId"]!])
                NSApplication.shared.terminate(nil)
            }
        } catch { print("viewer_error \(error)"); NSApplication.shared.terminate(nil) } }
    }
    func refresh() async throws {
        let result = try await client.send("Page.captureScreenshot", ["format":"png"], session)
        guard let encoded = result["data"] as? String, let data = Data(base64Encoded: encoded), let screenshot = NSImage(data: data) else { throw NSError(domain:"Screenshot",code:1) }
        screenshot.size = NSSize(width:800,height:600)
        image.image = screenshot
    }
}
@main struct Viewer {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = Delegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
