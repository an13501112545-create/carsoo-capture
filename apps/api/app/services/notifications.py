from dataclasses import dataclass
from typing import Dict, Optional, Protocol


@dataclass
class SellerNotificationPayload:
    channel: str
    recipient: str
    message: str
    metadata: Dict[str, str]


class SMSProvider(Protocol):
    def prepare(self, recipient: str, message: str, metadata: Dict[str, str]) -> SellerNotificationPayload:
        ...


class EmailProvider(Protocol):
    def prepare(self, recipient: str, subject: str, message: str, metadata: Dict[str, str]) -> SellerNotificationPayload:
        ...


class PlaceholderSMSProvider:
    def prepare(self, recipient: str, message: str, metadata: Dict[str, str]) -> SellerNotificationPayload:
        return SellerNotificationPayload(
            channel="sms",
            recipient=recipient,
            message=message,
            metadata={"provider": "placeholder", **metadata},
        )


class PlaceholderEmailProvider:
    def prepare(self, recipient: str, subject: str, message: str, metadata: Dict[str, str]) -> SellerNotificationPayload:
        return SellerNotificationPayload(
            channel="email",
            recipient=recipient,
            message=f"{subject}\n\n{message}",
            metadata={"provider": "placeholder", "subject": subject, **metadata},
        )


class SellerNotificationService:
    def __init__(self, sms_provider: SMSProvider, email_provider: EmailProvider):
        self.sms_provider = sms_provider
        self.email_provider = email_provider

    def prepare_capture_messages(
        self,
        *,
        capture_url: str,
        seller_name: Optional[str],
        seller_phone: Optional[str],
        seller_email: Optional[str],
        session_id: int,
    ) -> Dict[str, Optional[Dict[str, str]]]:
        name = seller_name or "there"
        message = (
            f"Hi {name}, your Carsoo capture is ready. Open this secure link on your phone: {capture_url}"
        )
        metadata = {"session_id": str(session_id), "capture_url": capture_url}
        sms_payload = None
        email_payload = None
        if seller_phone:
            sms_payload = self.sms_provider.prepare(seller_phone, message, metadata).__dict__
        if seller_email:
            email_payload = self.email_provider.prepare(
                seller_email,
                "Carsoo seller capture link",
                message,
                metadata,
            ).__dict__
        return {"sms": sms_payload, "email": email_payload}
