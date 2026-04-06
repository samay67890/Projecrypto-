from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import Wallet


@receiver(post_save, sender=settings.AUTH_USER_MODEL)
def ensure_user_wallet(sender, instance, created, **kwargs):
    # Django fixture loading sets raw=True; skip auto-wallet creation there
    # to avoid conflicts with wallet objects present in the fixture.
    if kwargs.get("raw"):
        return
    if not created:
        return
    wallet, _ = Wallet.objects.get_or_create(user=instance)
    if not wallet.wallet_address:
        wallet.save()
