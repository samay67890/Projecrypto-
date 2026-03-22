"""Email service for sending OTP verification emails via Brevo SMTP."""
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string
from django.conf import settings
import logging

logger = logging.getLogger(__name__)


def send_otp_email(email, otp_code):
    """
    Send OTP verification email to the user via Brevo SMTP.
    
    Args:
        email: Recipient email address
        otp_code: The 6-digit OTP code to include in the email
        
    Returns:
        bool: True if email was sent successfully, False otherwise
    """
    try:
        # Check if email backend is configured
        if not settings.EMAIL_HOST_USER or not settings.EMAIL_HOST_PASSWORD:
            logger.warning(
                "Email credentials not configured (EMAIL_HOST_USER or EMAIL_HOST_PASSWORD empty). "
                "Skipping OTP email send."
            )
            return False
        
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
        
        # Create email with both plain-text and HTML content
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
        
        logger.info(f"OTP email sent successfully to {email}")
        return True
        
    except Exception as e:
        logger.error(
            f"Failed to send OTP email to {email}: {e.__class__.__name__}: {e}",
            exc_info=True,
        )
        return False
