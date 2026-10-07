"""Material photo storage in Cloudinary.

Needs CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.
Without them uploads are refused with a clear 503; everything else works.

Images are uploaded as-is (the browser already shrinks them) and always
delivered through a size-limited JPEG transformation, so phones' HEIC photos
display everywhere and the AI check gets a reasonably sized image.
"""
import io
import secrets

from flask import current_app

from errors import APIError

MAX_BYTES = 10 * 1024 * 1024           # per photo, before upload
DELIVERY = {"crop": "limit", "width": 1600, "height": 1600, "quality": "auto"}

# Leading bytes of the image types we accept.
_SIGNATURES = (
    (b"\xff\xd8\xff", "jpeg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


def sniff_image_type(data):
    """'jpeg' | 'png' | 'gif' | 'webp' | 'heic' - or None if it isn't an image we take."""
    for magic, kind in _SIGNATURES:
        if data.startswith(magic):
            return kind
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"mif1", b"msf1", b"heif"):
        return "heic"
    return None


def is_configured():
    c = current_app.config
    return all(c.get(k) for k in ("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"))


def _cloudinary():
    if not is_configured():
        raise APIError("Photo storage isn't configured on this server (CLOUDINARY_CLOUD_NAME, "
                       "CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are not set)", 503)
    try:
        import cloudinary
        import cloudinary.uploader
        import cloudinary.utils
    except ImportError:
        current_app.logger.exception("cloudinary package missing")
        raise APIError("Photo storage isn't available (the 'cloudinary' package is not installed)", 503)
    c = current_app.config
    cloudinary.config(cloud_name=c["CLOUDINARY_CLOUD_NAME"], api_key=c["CLOUDINARY_API_KEY"],
                      api_secret=c["CLOUDINARY_API_SECRET"], secure=True)
    return cloudinary


def upload(data, work_order_id, material_id):
    """Upload image bytes. Returns {public_id, url, width, height, bytes}."""
    cloudinary = _cloudinary()
    public_id = f"wo-{work_order_id:05d}-mat-{material_id}-{secrets.token_hex(6)}"
    try:
        result = cloudinary.uploader.upload(
            io.BytesIO(data), filename="photo", public_id=public_id, folder="work-order-materials",
            resource_type="image", overwrite=False, timeout=30,
        )
    except Exception as exc:   # SDK raises its own Error class, plus network errors
        current_app.logger.warning("Cloudinary upload failed: %s", exc)
        raise APIError("The photo couldn't be uploaded to storage - please try again", 502)
    url, _ = cloudinary.utils.cloudinary_url(
        result["public_id"], version=result.get("version"), format="jpg", secure=True, **DELIVERY)
    return {"public_id": result["public_id"], "url": url, "width": result.get("width"),
            "height": result.get("height"), "bytes": result.get("bytes")}


def destroy_quietly(public_id):
    """Best-effort delete (after the database change is committed). A failure
    only leaves an orphaned image in Cloudinary, so it's logged, not raised."""
    if not public_id or not is_configured():
        return
    try:
        _cloudinary().uploader.destroy(public_id, resource_type="image", invalidate=True, timeout=15)
    except Exception as exc:
        current_app.logger.warning("Could not delete Cloudinary image %s: %s", public_id, exc)
