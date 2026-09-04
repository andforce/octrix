import AVFoundation
import Combine
import Foundation
import Speech

enum SpeechInputState: Equatable {
    case idle
    case requestingPermission
    case recording
    case stopping
    case failed(String)

    var isActive: Bool {
        switch self {
        case .requestingPermission, .recording, .stopping:
            return true
        case .idle, .failed:
            return false
        }
    }
}

private enum SpeechInputError: LocalizedError {
    case speechDenied
    case microphoneDenied
    case recognizerUnavailable
    case audioInputUnavailable

    var errorDescription: String? {
        switch self {
        case .speechDenied:
            "请在系统设置中允许 Octrix 使用语音识别"
        case .microphoneDenied:
            "请在系统设置中允许 Octrix 使用麦克风"
        case .recognizerUnavailable:
            "当前系统语音识别不可用，请稍后重试"
        case .audioInputUnavailable:
            "当前设备没有可用的音频输入"
        }
    }
}

@MainActor
final class SpeechInputController: ObservableObject {
    @Published private(set) var state: SpeechInputState = .idle
    @Published private(set) var transcript = ""
    @Published private(set) var elapsedSeconds = 0
    @Published private(set) var waveformLevels: [Double] = AudioLevelMeter.silenceLevels
    @Published private(set) var errorMessage: String?

    private let speechRecognizer = SFSpeechRecognizer(locale: .current)
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var elapsedTimer: Timer?
    private var tapInstalled = false
    private var startDate: Date?

    var isActive: Bool {
        state.isActive
    }

    func startRecording() async throws {
        guard !state.isActive else { return }

        state = .requestingPermission
        errorMessage = nil
        transcript = ""
        elapsedSeconds = 0
        waveformLevels = AudioLevelMeter.silenceLevels

        do {
            try await requestPermissions()
            try beginAudioRecognition()
        } catch {
            fail(error)
            throw error
        }
    }

    func finishRecording() async -> String {
        guard state.isActive else {
            let value = transcript
            resetTranscript()
            return value
        }

        state = .stopping
        stopAudioEngine(endAudio: true)
        try? await Task.sleep(for: .milliseconds(450))

        let value = transcript
        cleanupRecognition(cancelTask: true)
        state = .idle
        resetTranscript()
        return value
    }

    func cancelRecording() {
        guard state.isActive || !transcript.isEmpty else { return }
        cleanupRecognition(cancelTask: true)
        state = .idle
        resetTranscript()
    }

    private func requestPermissions() async throws {
        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
        guard speechStatus == .authorized else {
            throw SpeechInputError.speechDenied
        }

        let microphoneGranted = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
        guard microphoneGranted else {
            throw SpeechInputError.microphoneDenied
        }
    }

    private func beginAudioRecognition() throws {
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            throw SpeechInputError.recognizerUnavailable
        }

        cleanupRecognition(cancelTask: true)

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        recognitionTask = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                self?.handleRecognition(result: result, error: error)
            }
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        guard recordingFormat.sampleRate > 0, recordingFormat.channelCount > 0 else {
            throw SpeechInputError.audioInputUnavailable
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self, weak request] buffer, _ in
            request?.append(buffer)
            let level = AudioLevelMeter.normalizedLevel(from: buffer)
            Task { @MainActor in
                self?.appendWaveformLevel(level)
            }
        }
        tapInstalled = true

        audioEngine.prepare()
        try audioEngine.start()

        startDate = Date()
        elapsedSeconds = 0
        startTimer()
        state = .recording
    }

    private func handleRecognition(result: SFSpeechRecognitionResult?, error: Error?) {
        if let result {
            transcript = result.bestTranscription.formattedString
        }

        if let error, case .recording = state {
            fail(error)
        }
    }

    private func fail(_ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        errorMessage = message
        cleanupRecognition(cancelTask: true)
        state = .failed(message)
    }

    private func stopAudioEngine(endAudio: Bool) {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        if endAudio {
            recognitionRequest?.endAudio()
        }
        stopTimer()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func cleanupRecognition(cancelTask: Bool) {
        stopAudioEngine(endAudio: false)
        if cancelTask {
            recognitionTask?.cancel()
        }
        recognitionTask = nil
        recognitionRequest = nil
        startDate = nil
    }

    private func startTimer() {
        stopTimer()
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let startDate = self.startDate else { return }
                self.elapsedSeconds = max(0, Int(Date().timeIntervalSince(startDate)))
            }
        }
    }

    private func stopTimer() {
        elapsedTimer?.invalidate()
        elapsedTimer = nil
    }

    private func appendWaveformLevel(_ level: Double) {
        let previous = waveformLevels.last ?? AudioLevelMeter.silenceLevel
        let smoothedLevel = min(1, max(AudioLevelMeter.silenceLevel, previous * 0.28 + level * 0.72))
        var levels = waveformLevels
        if levels.count >= AudioLevelMeter.sampleCount {
            levels.removeFirst(levels.count - AudioLevelMeter.sampleCount + 1)
        }
        levels.append(smoothedLevel)
        while levels.count < AudioLevelMeter.sampleCount {
            levels.insert(AudioLevelMeter.silenceLevel, at: 0)
        }
        waveformLevels = levels
    }

    private func resetTranscript() {
        transcript = ""
        elapsedSeconds = 0
        waveformLevels = AudioLevelMeter.silenceLevels
    }
}

private enum AudioLevelMeter {
    static let sampleCount = 28
    static let silenceLevel = 0.08
    static var silenceLevels: [Double] {
        Array(repeating: silenceLevel, count: sampleCount)
    }

    static func normalizedLevel(from buffer: AVAudioPCMBuffer) -> Double {
        guard let channels = buffer.floatChannelData else {
            return silenceLevel
        }

        let frameLength = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frameLength > 0, channelCount > 0 else {
            return silenceLevel
        }

        var sum: Float = 0
        var sampleCount = 0

        for channelIndex in 0..<channelCount {
            let channel = channels[channelIndex]
            for frameIndex in 0..<frameLength {
                let sample = channel[frameIndex]
                sum += sample * sample
            }
            sampleCount += frameLength
        }

        guard sampleCount > 0 else {
            return silenceLevel
        }

        let rms = sqrt(sum / Float(sampleCount))
        guard rms > 0 else {
            return silenceLevel
        }

        let decibels = 20 * log10(Double(rms))
        let floorDecibels = -55.0
        let ceilingDecibels = -6.0
        let clippedDecibels = min(ceilingDecibels, max(floorDecibels, decibels))
        let normalized = (clippedDecibels - floorDecibels) / (ceilingDecibels - floorDecibels)
        return max(silenceLevel, min(1, pow(normalized, 0.62)))
    }
}
