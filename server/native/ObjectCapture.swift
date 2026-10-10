import Foundation
import RealityKit

@main
struct TiksiObjectCapture {
    static func emit(_ payload: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) {
            print(line)
            fflush(stdout)
        }
    }
    static func main() async {
        guard PhotogrammetrySession.isSupported else {
            emit(["event": "error", "message": "Apple Object Capture is not supported on this Mac."])
            exit(2)
        }
        let args = CommandLine.arguments
        if args.count == 2 && args[1] == "--check" {
            emit(["event": "available", "engine": "Apple Object Capture"])
            return
        }
        guard args.count == 5 else { emit(["event": "error", "message": "Usage: object-capture INPUT OUTPUT QUALITY ORDER"]); exit(2) }
        let details: [String: PhotogrammetrySession.Request.Detail] = ["preview": .preview, "reduced": .reduced, "medium": .medium, "full": .full, "raw": .raw]
        guard let detail = details[args[3]] else { emit(["event": "error", "message": "Invalid quality"]); exit(2) }
        do {
            var configuration = PhotogrammetrySession.Configuration()
            configuration.sampleOrdering = args[4] == "sequential" ? .sequential : .unordered
            configuration.featureSensitivity = .high
            let session = try PhotogrammetrySession(input: URL(fileURLWithPath: args[1], isDirectory: true), configuration: configuration)
            let request = PhotogrammetrySession.Request.modelFile(url: URL(fileURLWithPath: args[2], isDirectory: true), detail: detail)
            try session.process(requests: [request])
            var complete = false
            for try await output in session.outputs {
                switch output {
                case .requestProgress(_, let fraction): emit(["event": "progress", "progress": fraction])
                case .requestComplete(_, let result):
                    if case .modelFile = result { complete = true; emit(["event": "modelComplete"]) }
                case .requestError(_, let error): emit(["event": "error", "message": String(describing: error)]); exit(1)
                case .invalidSample(let id, let reason): emit(["event": "warning", "message": "Skipped image \(id): \(reason)"])
                case .skippedSample(let id): emit(["event": "warning", "message": "Skipped image \(id)"])
                case .automaticDownsampling: emit(["event": "warning", "message": "The engine reduced image resolution to fit available memory."])
                case .processingComplete:
                    if complete { emit(["event": "complete"]); return }
                    emit(["event": "error", "message": "Processing ended without a model."]); exit(1)
                case .processingCancelled: emit(["event": "cancelled"]); exit(130)
                default: break
                }
            }
            if !complete { throw NSError(domain: "Tiksi", code: 1, userInfo: [NSLocalizedDescriptionKey: "No reconstructed model was produced."]) }
        } catch { emit(["event": "error", "message": error.localizedDescription]); exit(1) }
    }
}
