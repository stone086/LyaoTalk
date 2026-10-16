from app.api.routers.attachments import ALLOWED_MIME_TYPES, base_media_type


def test_recorded_webm_codec_parameter_is_allowed():
    assert base_media_type("audio/webm;codecs=opus") == "audio/webm"
    assert base_media_type(" AUDIO/WEBM; codecs=opus ") in ALLOWED_MIME_TYPES
