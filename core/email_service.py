"""Email service for sending OTP verification emails."""
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string
from django.conf import settings
import logging
import json as _json
import time as _time

logger = logging.getLogger(__name__)

# region agent log
_DEBUG_LOG_PATH = r"d:\Downloads\NexusCrypto-main\.cursor\debug.log"


def _dbg_log(*, runId: str, hypothesisId: str, location: str, message: str, data: dict | None = None):
    try:
        payload = {
            "id": f"log_{_time.time_ns()}",
            "timestamp": int(_time.time() * 1000),
            "runId": runId,
            "hypothesisId": hypothesisId,
            "location": location,
            "message": message,
            "data": data or {},
        }
        with open(_DEBUG_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(_json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        pass

# endregion agent log


def send_otp_email(email, otp_code):
    """
    Send OTP verification email to the user.
    
    Args:
        email: Recipient email address
        otp_code: The 6-digit OTP code to include in the email
        
    Returns:
        bool: True if email was sent successfully, False otherwise
    """
    try:
        # Check if email backend is configured
        if not settings.EMAIL_HOST_USER or not settings.EMAIL_HOST_PASSWORD:
            # region agent log
            _dbg_log(
                runId="pre-fix",
                hypothesisId="H4",
                location="core/email_service.py:send_otp_email:not_configured",
                message="Email credentials missing",
                data={"backend": getattr(settings, "EMAIL_BACKEND", None)},
            )
            # endregion agent log
            logger.warning("Email credentials not configured; skipping send.")
            return False
        
        # Check if using placeholder password
        if settings.EMAIL_HOST_PASSWORD == 'your-gmail-app-password-here':
            # region agent log
            _dbg_log(
                runId="pre-fix",
                hypothesisId="H4",
                location="core/email_service.py:send_otp_email:placeholder_password",
                message="Placeholder EMAIL_HOST_PASSWORD detected; skipping send",
                data={},
            )
            # endregion agent log
            logger.warning("Email password is placeholder; skipping send.")
            return False
        
        # Check if password looks like a regular password (not App Password)
        # Gmail App Passwords are 16 characters with no spaces
        pwd = settings.EMAIL_HOST_PASSWORD or ''
        if pwd and len(pwd) < 16 and ' ' not in pwd:
            # region agent log
            _dbg_log(
                runId="pre-fix",
                hypothesisId="H4",
                location="core/email_service.py:send_otp_email:likely_regular_password",
                message="EMAIL_HOST_PASSWORD appears to be regular password (not App Password)",
                data={"pwd_len": len(pwd)},
            )
            # endregion agent log
            logger.warning("Email password may be regular password instead of App Password. Gmail requires App Passwords for SMTP.")
            # Still try to send - might work if 2FA is disabled, but likely will fail
        
        # Render HTML email template
        html_content = render_to_string(
            'emails/otp/verification.html',
            {
                'otp_code': otp_code,
            }
        )
        
        # Create email message
        subject = 'NexusCrypto - Verify Your Email'
        from_email = settings.DEFAULT_FROM_EMAIL
        to_email = [email]
        
        # Create email with HTML content
        email_message = EmailMultiAlternatives(
            subject=subject,
            body=f'Your verification code is: {otp_code}\n\nThis code will expire in 10 minutes.',
            from_email=from_email,
            to=to_email,
        )
        
        # Attach HTML version
        email_message.attach_alternative(html_content, 'text/html')
        
        # Send email
        email_message.send()
        
        # region agent log
        _dbg_log(
            runId="pre-fix",
            hypothesisId="H4",
            location="core/email_service.py:send_otp_email:sent",
            message="Email send() succeeded",
            data={},
        )
        # endregion agent log
        logger.info("OTP email sent successfully.")
        return True
        
    except Exception as e:
        # Log error details
        # region agent log
        _dbg_log(
            runId="pre-fix",
            hypothesisId="H4",
            location="core/email_service.py:send_otp_email:exception",
            message="Email send() raised",
            data={"err_type": e.__class__.__name__},
        )
        # endregion agent log
        logger.error("Error sending OTP email.", exc_info=True)
        
        return False
