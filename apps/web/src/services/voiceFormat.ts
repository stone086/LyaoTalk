/** Produce an actual AAC-in-MP4 voice message, never a renamed WebM file. */
export async function voiceRecordingToM4a(recording: Blob, mimeType: string): Promise<File> {
  if (!recording.size) throw new Error("Recording is empty");
  const name = `voice-${Date.now()}.m4a`;
  if (/^audio\/mp4\s*;.*codecs\s*=\s*"?mp4a\.40\.2/i.test(mimeType)) {
    return new File([recording], name, { type: "audio/mp4" });
  }

  const { Input, ALL_FORMATS, BlobSource, Output, BufferTarget, Mp4OutputFormat, Conversion, canEncodeAudio } = await import("mediabunny");
  if (!(await canEncodeAudio("aac"))) {
    const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
    registerAacEncoder();
  }
  const input = new Input({ source: new BlobSource(recording), formats: ALL_FORMATS });
  try {
    if (!(await input.getPrimaryAudioTrack())) throw new Error("Recording contains no audio");
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const conversion = await Conversion.init({ input, output, video: { discard: true }, audio: { codec: "aac", bitrate: 48000 } });
    if (!conversion.isValid || !conversion.utilizedTracks.length) throw new Error("AAC conversion is unavailable");
    await conversion.execute();
    if (!target.buffer?.byteLength) throw new Error("AAC conversion produced no audio");
    return new File([target.buffer], name, { type: "audio/mp4" });
  } finally {
    input.dispose();
  }
}
