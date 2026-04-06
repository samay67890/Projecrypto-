import uuid
from decimal import Decimal

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

class Wallet(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='wallet')
    wallet_address = models.CharField(max_length=255, unique=True, blank=True, null=True)
    balance = models.DecimalField(max_digits=30, decimal_places=8, default=1000000.00, help_text="Primary USDT Balance")
    btc_balance = models.DecimalField(max_digits=30, decimal_places=8, default=0.00, help_text="Secondary BTC Balance")
    total_deposits = models.DecimalField(max_digits=30, decimal_places=8, default=0.00)
    total_withdrawals = models.DecimalField(max_digits=30, decimal_places=8, default=0.00)

    def __str__(self):
        return f"{self.user.email} Wallet"

    def save(self, *args, **kwargs):
        if not self.wallet_address:
            self.wallet_address = f"NEXUS-{uuid.uuid4().hex[:24].upper()}"
        super().save(*args, **kwargs)

    def get_asset_balance(self, symbol: str) -> Decimal:
        asset_symbol = (symbol or '').upper().strip()
        if not asset_symbol:
            return Decimal('0')
        if asset_symbol == 'USDT':
            return self.balance
        if asset_symbol == 'BTC':
            return self.btc_balance
        asset = self.assets.filter(symbol=asset_symbol).first()
        return asset.balance if asset else Decimal('0')

    def set_asset_balance(self, symbol: str, amount) -> Decimal:
        asset_symbol = (symbol or '').upper().strip()
        safe_amount = Decimal(str(amount or 0))
        if asset_symbol == 'USDT':
            self.balance = safe_amount
            self.save(update_fields=['balance'])
            return self.balance
        if asset_symbol == 'BTC':
            self.btc_balance = safe_amount
            self.save(update_fields=['btc_balance'])
            return self.btc_balance

        asset, _ = self.assets.get_or_create(symbol=asset_symbol, defaults={'balance': Decimal('0')})
        asset.balance = safe_amount
        asset.save(update_fields=['balance'])
        return asset.balance

    def asset_map(self):
        balances = {'USDT': self.balance, 'BTC': self.btc_balance}
        for asset in self.assets.all():
            balances[asset.symbol] = asset.balance
        return balances


class WalletAsset(models.Model):
    wallet = models.ForeignKey(Wallet, on_delete=models.CASCADE, related_name='assets')
    symbol = models.CharField(max_length=20)
    balance = models.DecimalField(max_digits=30, decimal_places=8, default=0.00)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = ('wallet', 'symbol')
        ordering = ['symbol']

    def save(self, *args, **kwargs):
        self.symbol = (self.symbol or '').upper().strip()
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.wallet.user.email} {self.symbol}"


class WalletTransaction(models.Model):
    TRANSACTION_TYPES = (
        ('deposit', 'Deposit'),
        ('withdrawal', 'Withdrawal'),
        ('spot_buy_quote', 'Spot Buy (Quote Debit)'),
        ('spot_buy_asset', 'Spot Buy (Asset Credit)'),
        ('spot_sell_asset', 'Spot Sell (Asset Debit)'),
        ('spot_sell_quote', 'Spot Sell (Quote Credit)'),
        ('margin_open', 'Margin Open (USDT Debit)'),
        ('margin_close', 'Margin Close (USDT Credit)'),
        ('margin_close_loss', 'Margin Close (USDT Debit)'),
        ('futures_open', 'Futures Open (USDT Debit)'),
        ('futures_close', 'Futures Close (USDT Credit)'),
        ('futures_close_loss', 'Futures Close (USDT Debit)'),
    )
    STATUS_CHOICES = (
        ('completed', 'Completed'),
        ('pending', 'Pending'),
        ('failed', 'Failed'),
    )

    wallet = models.ForeignKey(Wallet, on_delete=models.CASCADE, related_name='transactions')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='wallet_transactions')
    reference = models.CharField(max_length=64, unique=True)
    tx_type = models.CharField(max_length=20, choices=TRANSACTION_TYPES)
    asset = models.CharField(max_length=20, default='USDT')
    amount = models.DecimalField(max_digits=30, decimal_places=8)
    method = models.CharField(max_length=120, blank=True, default='')
    status = models.CharField(max_length=30, choices=STATUS_CHOICES, default='completed')
    details = models.CharField(max_length=255, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', 'created_at']),
            models.Index(fields=['wallet', 'created_at']),
        ]

    def save(self, *args, **kwargs):
        self.asset = (self.asset or 'USDT').upper().strip()
        if not self.reference:
            self.reference = f"TX-{uuid.uuid4().hex[:16].upper()}"
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.get_tx_type_display()} {self.amount} {self.asset}"

class Trade(models.Model):
    SIDE_CHOICES = (
        ('Buy', 'Buy'),
        ('Sell', 'Sell'),
        ('Long', 'Long'),
        ('Short', 'Short'),
        ('Close', 'Close'),
    )
    MARKET_TYPE_CHOICES = (
        ('spot', 'Spot'),
        ('margin', 'Margin'),
        ('futures', 'Futures'),
    )
    EVENT_TYPE_CHOICES = (
        ('spot_fill', 'Spot Fill'),
        ('margin_open', 'Margin Open'),
        ('margin_close', 'Margin Close'),
        ('futures_open', 'Futures Open'),
        ('futures_close', 'Futures Close'),
    )

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='trades')
    trade_id = models.CharField(max_length=100, unique=True)
    coin = models.CharField(max_length=50, default="BTCUSDT")
    side = models.CharField(max_length=20, choices=SIDE_CHOICES, help_text="Buy, Sell, Long, Short or Close")
    price = models.DecimalField(max_digits=30, decimal_places=8)
    amount = models.DecimalField(max_digits=30, decimal_places=8)
    total_value = models.DecimalField(max_digits=30, decimal_places=8, help_text="price * amount")
    profit_loss = models.DecimalField(max_digits=30, decimal_places=8, default=0.00)
    market_type = models.CharField(max_length=20, choices=MARKET_TYPE_CHOICES, default="spot", help_text="spot or futures")
    event_type = models.CharField(max_length=30, choices=EVENT_TYPE_CHOICES, default="spot_fill", help_text="spot_fill, futures_open, futures_close")
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['user', 'timestamp']),
            models.Index(fields=['coin', 'timestamp']),
            models.Index(fields=['market_type', 'event_type']),
        ]

    def __str__(self):
        return f"{self.side} {self.amount} {self.coin} @ {self.price}"

    def save(self, *args, **kwargs):
        self.coin = (self.coin or 'BTCUSDT').upper().strip()
        super().save(*args, **kwargs)


class Position(models.Model):
    SIDE_CHOICES = (
        ('long', 'Long'),
        ('short', 'Short'),
    )
    MARKET_TYPE_CHOICES = (
        ('margin', 'Margin'),
        ('futures', 'Futures'),
    )
    STATUS_CHOICES = (
        ('open', 'Open'),
        ('closed', 'Closed'),
    )

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='positions')
    wallet = models.ForeignKey(Wallet, on_delete=models.CASCADE, related_name='positions')
    position_id = models.CharField(max_length=100, unique=True)
    symbol = models.CharField(max_length=50, default='BTCUSDT')
    market_type = models.CharField(max_length=20, choices=MARKET_TYPE_CHOICES)
    side = models.CharField(max_length=20, choices=SIDE_CHOICES)
    amount = models.DecimalField(max_digits=30, decimal_places=8)
    entry_price = models.DecimalField(max_digits=30, decimal_places=8)
    leverage = models.DecimalField(max_digits=10, decimal_places=2, default=1.00)
    margin = models.DecimalField(max_digits=30, decimal_places=8, default=0.00)
    take_profit = models.DecimalField(max_digits=30, decimal_places=8, null=True, blank=True)
    stop_loss = models.DecimalField(max_digits=30, decimal_places=8, null=True, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='open')
    close_price = models.DecimalField(max_digits=30, decimal_places=8, null=True, blank=True)
    realized_pnl = models.DecimalField(max_digits=30, decimal_places=8, default=0.00)
    opened_at = models.DateTimeField(auto_now_add=True)
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-opened_at']
        indexes = [
            models.Index(fields=['user', 'market_type', 'status']),
            models.Index(fields=['symbol', 'status']),
        ]

    def save(self, *args, **kwargs):
        self.symbol = (self.symbol or 'BTCUSDT').upper().strip()
        if not self.position_id:
            self.position_id = f"POS-{uuid.uuid4().hex[:16].upper()}"
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.market_type} {self.side} {self.amount} {self.symbol}"
