from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Custom user with email as primary identifier."""
    email = models.EmailField(unique=True)
    username = models.CharField(max_length=150, blank=True, null=True, unique=True)

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = []


class OTP(models.Model):
    """One-time password for authentication."""
    email = models.EmailField(
        help_text='Email address this OTP is sent to (used before user creation)',
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='otps',
        null=True,
        blank=True,
        help_text='User this OTP belongs to (null until account is created)',
    )
    otp_hash = models.CharField(
        max_length=128,
        help_text="Hashed OTP using Django's password hasher for security",
    )
    created_at = models.DateTimeField(
        auto_now_add=True,
        help_text='Timestamp when OTP was created',
    )
    expires_at = models.DateTimeField(
        help_text='Timestamp when OTP expires (10 minutes from creation)',
    )
    is_used = models.BooleanField(
        default=False,
        help_text='Whether this OTP has been used for authentication',
    )

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['email', 'expires_at']),
            models.Index(fields=['user', 'expires_at']),
        ]
        verbose_name = 'OTP'
        verbose_name_plural = 'OTPs'
