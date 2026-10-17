/** Encode camera recordings as real H.264/AAC MP4 files for other chat clients. */
export async function videoRecordingToMp4(recording: Blob): Promise<File> {
  if (!recording.size) throw new Error("Recording is empty");

  const { Input, ALL_FORMATS, BlobSource, Output, BufferTarget, Mp4OutputFormat, Conversion, canEncodeAudio } = await import("mediabunny");
  if (!(await canEncodeAudio("aac"))) {
    const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
    registerAacEncoder();
  }

  const input = new Input({ source: new BlobSource(recording), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("Recording contains no video");
    const audioTrack = await input.getPrimaryAudioTrack();
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    // Mediabunny copies already-compatible tracks and transcodes WebM or other codecs.
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { codec: "avc" },
      audio: { codec: "aac" },
    });
    if (!conversion.isValid || !conversion.utilizedTracks.includes(videoTrack) ||
        (audioTrack && !conversion.utilizedTracks.includes(audioTrack))) {
      throw new Error("H.264/AAC conversion is unavailable");
    }
    await conversion.execute();
    if (!target.buffer?.byteLength) throw new Error("MP4 conversion produced no video");
    return new File([target.buffer], `video-${Date.now()}.mp4`, { type: "video/mp4" });
  } finally {
    input.dispose();
  }
}
