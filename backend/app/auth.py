import hmac

from . import config


def valid(token: str | None) -> bool:
    if not config.ACCESS_TOKEN:
        return True
    return bool(token) and hmac.compare_digest(token, config.ACCESS_TOKEN)
