from app.api.routers.attachments import ALLOWED_MIME_TYPES, base_media_type


def test_recorded_webm_codec_parameter_is_allowed():
    assert base_media_type("audio/webm;codecs=opus") == "audio/webm"
    assert base_media_type(" AUDIO/WEBM; codecs=opus ") in ALLOWED_MIME_TYPES


def test_common_documents_and_archives_are_allowed():
    for mime_type in (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/msword",
        "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint",
        "text/csv",
        "application/vnd.oasis.opendocument.text",
        "application/x-7z-compressed",
        "application/vnd.rar",
    ):
        assert mime_type in ALLOWED_MIME_TYPES


def test_executables_and_active_web_content_remain_disallowed():
    for mime_type in ("application/x-dosexec", "application/x-executable", "text/html", "image/svg+xml"):
        assert mime_type not in ALLOWED_MIME_TYPES


def test_common_audio_and_video_are_allowed():
    for mime_type in (
        "audio/mpeg", "audio/mp4", "audio/aac", "audio/flac", "audio/x-wav",
        "video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska",
        "video/mpeg", "video/3gpp", "video/x-ms-wmv",
    ):
        assert mime_type in ALLOWED_MIME_TYPES
