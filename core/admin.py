from decimal import Decimal

from django.apps import apps
from django.contrib import admin, messages
from django.contrib.admin.sites import AlreadyRegistered
from django.contrib.auth import get_user_model
from django.db import models
from django.db.utils import DatabaseError, OperationalError, ProgrammingError
from django.db.models import DecimalField, ExpressionWrapper, F, Sum
from django.db.models.functions import Coalesce
from django.utils import timezone


def get_model_by_name(model_name):
    for model in apps.get_models():
        if model.__name__.lower() == model_name.lower():
            return model
    return None


def has_field(model, field_name):
    return any(field.name == field_name for field in model._meta.get_fields())


def first_field(model, candidates):
    for name in candidates:
        if has_field(model, name):
            return name
    return None


def safe_value(obj, attr_name, default="-"):
    value = getattr(obj, attr_name, default)
    if value in (None, ""):
        return default
    return value


def get_user_status(obj):
    if hasattr(obj, "account_status"):
        return obj.account_status
    return "active" if getattr(obj, "is_active", False) else "suspended"


def get_kyc_model():
    return get_model_by_name("KYC")


def get_wallet_model():
    return get_model_by_name("Wallet")


def get_trade_model():
    return get_model_by_name("Trade")


def get_wallet_asset_model():
    return get_model_by_name("WalletAsset")


def get_wallet_transaction_model():
    return get_model_by_name("WalletTransaction")


def get_position_model():
    return get_model_by_name("Position")


def register_or_replace(model, admin_class):
    if not model:
        return
    try:
        admin.site.register(model, admin_class)
    except AlreadyRegistered:
        admin.site.unregister(model)
        admin.site.register(model, admin_class)


def get_dashboard_metrics():
    User = get_user_model()
    KYC = get_kyc_model()
    Trade = get_trade_model()
    Transaction = get_model_by_name("Transaction") or get_wallet_transaction_model()
    CryptoCoin = get_model_by_name("CryptoCoin")

    total_users = User.objects.count()
    total_trades = Trade.objects.count() if Trade else 0
    total_transactions = Transaction.objects.count() if Transaction else 0

    total_volume = Decimal("0")
    if Trade:
        if has_field(Trade, "total_value"):
            total_volume = Trade.objects.aggregate(
                volume=Coalesce(Sum("total_value"), Decimal("0"))
            )["volume"]
        elif has_field(Trade, "price") and has_field(Trade, "amount"):
            expr = ExpressionWrapper(
                F("price") * F("amount"),
                output_field=DecimalField(max_digits=30, decimal_places=8),
            )
            total_volume = Trade.objects.aggregate(
                volume=Coalesce(Sum(expr), Decimal("0"))
            )["volume"]

    active_coins = 0
    if CryptoCoin:
        status_field = first_field(CryptoCoin, ["trading_status", "status"])
        if status_field:
            status_model_field = CryptoCoin._meta.get_field(status_field)
            if isinstance(status_model_field, models.BooleanField):
                active_coins = CryptoCoin.objects.filter(**{status_field: True}).count()
            else:
                active_coins = CryptoCoin.objects.filter(
                    **{f"{status_field}__in": ["active", "enabled", "trading", "ACTIVE", "ENABLED"]}
                ).count()
        elif has_field(CryptoCoin, "is_active"):
            active_coins = CryptoCoin.objects.filter(is_active=True).count()

    pending_kyc = 0
    if KYC and has_field(KYC, "status"):
        pending_kyc = KYC.objects.filter(
            status__in=["pending", "PENDING", "Pending"]
        ).count()

    return {
        "total_users": total_users,
        "total_trades": total_trades,
        "total_transactions": total_transactions,
        "total_volume": total_volume,
        "active_coins": active_coins,
        "pending_kyc": pending_kyc,
    }


_original_each_context = admin.site.each_context


def _exchange_each_context(request):
    context = _original_each_context(request)
    try:
        context["exchange_metrics"] = get_dashboard_metrics()
    except (OperationalError, ProgrammingError, DatabaseError):
        # Keep admin pages usable even if migrations/tables are not ready yet.
        context["exchange_metrics"] = {
            "total_users": 0,
            "total_trades": 0,
            "total_transactions": 0,
            "total_volume": Decimal("0"),
            "active_coins": 0,
            "pending_kyc": 0,
        }
    return context


admin.site.each_context = _exchange_each_context
admin.site.site_header = "NexusCrypto Exchange Control Center"
admin.site.site_title = "NexusCrypto Admin"
admin.site.index_title = "Operations Dashboard"


class KYCStatusUserFilter(admin.SimpleListFilter):
    title = "KYC status"
    parameter_name = "kyc_status"

    def lookups(self, request, model_admin):
        return (
            ("pending", "Pending"),
            ("approved", "Approved"),
            ("rejected", "Rejected"),
        )

    def queryset(self, request, queryset):
        value = self.value()
        if not value:
            return queryset
        KYC = get_kyc_model()
        if not KYC or not has_field(KYC, "user") or not has_field(KYC, "status"):
            return queryset
        return queryset.filter(**{f"{KYC._meta.model_name}__status__iexact": value})


class AccountStatusFilter(admin.SimpleListFilter):
    title = "account status"
    parameter_name = "account_status"

    def lookups(self, request, model_admin):
        return (("active", "Active"), ("suspended", "Suspended"))

    def queryset(self, request, queryset):
        value = self.value()
        if not value:
            return queryset
        model = queryset.model
        if has_field(model, "account_status"):
            return queryset.filter(account_status__iexact=value)
        if has_field(model, "is_active"):
            return queryset.filter(is_active=(value == "active"))
        return queryset


class UserControlAdmin(admin.ModelAdmin):
    list_display = (
        "username_col",
        "email_col",
        "account_status_col",
        "kyc_status_col",
        "wallet_balance_col",
        "date_joined_col",
        "risk_score_col",
    )
    search_fields = ("username", "email")
    ordering = ("-date_joined",)
    actions = ("suspend_user", "activate_user", "promote_to_staff", "remove_staff", "delete_selected")

    @admin.display(description="Username", ordering="username")
    def username_col(self, obj):
        return safe_value(obj, "username", default=safe_value(obj, "email", default="(no username)"))

    @admin.display(description="Email", ordering="email")
    def email_col(self, obj):
        return safe_value(obj, "email")

    @admin.display(description="Account Status")
    def account_status_col(self, obj):
        return get_user_status(obj)

    @admin.display(description="KYC Status")
    def kyc_status_col(self, obj):
        if hasattr(obj, "kyc_status"):
            return safe_value(obj, "kyc_status")
        KYC = get_kyc_model()
        if not KYC or not has_field(KYC, "user"):
            return "-"
        latest = KYC.objects.filter(user=obj).order_by("-id").values_list("status", flat=True).first()
        return latest or "not_submitted"

    @admin.display(description="Wallet Balance")
    def wallet_balance_col(self, obj):
        if hasattr(obj, "wallet_balance"):
            return obj.wallet_balance
        Wallet = get_wallet_model()
        if not Wallet or not has_field(Wallet, "user"):
            return Decimal("0")
        balance_field = first_field(Wallet, ["balance", "wallet_balance"])
        if not balance_field:
            return Decimal("0")
        wallet = Wallet.objects.filter(user=obj).order_by("-id").first()
        return getattr(wallet, balance_field, Decimal("0")) if wallet else Decimal("0")

    @admin.display(description="Date Joined", ordering="date_joined")
    def date_joined_col(self, obj):
        return safe_value(obj, "date_joined")

    @admin.display(description="Risk Score")
    def risk_score_col(self, obj):
        return safe_value(obj, "risk_score", default=0)

    def get_list_filter(self, request):
        filters = [AccountStatusFilter, KYCStatusUserFilter]
        if has_field(self.model, "is_staff"):
            filters.append("is_staff")
        if has_field(self.model, "is_superuser"):
            filters.append("is_superuser")
        return tuple(filters)

    @admin.action(description="Suspend user")
    def suspend_user(self, request, queryset):
        model = queryset.model
        if has_field(model, "account_status"):
            updated = queryset.update(account_status="suspended")
        elif has_field(model, "is_active"):
            updated = queryset.update(is_active=False)
        else:
            updated = 0
        self.message_user(request, f"{updated} user(s) suspended.", level=messages.SUCCESS)

    @admin.action(description="Activate user")
    def activate_user(self, request, queryset):
        model = queryset.model
        if has_field(model, "account_status"):
            updated = queryset.update(account_status="active")
        elif has_field(model, "is_active"):
            updated = queryset.update(is_active=True)
        else:
            updated = 0
        self.message_user(request, f"{updated} user(s) activated.", level=messages.SUCCESS)

    @admin.action(description="Promote selected users to staff")
    def promote_to_staff(self, request, queryset):
        if not has_field(queryset.model, "is_staff"):
            self.message_user(request, "This user model has no is_staff field.", level=messages.WARNING)
            return
        updated = queryset.update(is_staff=True)
        self.message_user(request, f"{updated} user(s) promoted to staff.", level=messages.SUCCESS)

    @admin.action(description="Remove selected users from staff")
    def remove_staff(self, request, queryset):
        if not has_field(queryset.model, "is_staff"):
            self.message_user(request, "This user model has no is_staff field.", level=messages.WARNING)
            return
        updated = queryset.update(is_staff=False)
        self.message_user(request, f"{updated} user(s) removed from staff.", level=messages.WARNING)


class OTPAdmin(admin.ModelAdmin):
    list_display = ("email_col", "user_col", "is_used_col", "created_at_col", "expires_at_col")
    ordering = ("-created_at",)
    actions = ("mark_selected_as_used", "delete_expired_otps")

    @admin.display(description="Email", ordering="email")
    def email_col(self, obj):
        return safe_value(obj, "email")

    @admin.display(description="User")
    def user_col(self, obj):
        return safe_value(obj, "user")

    @admin.display(description="Used", ordering="is_used")
    def is_used_col(self, obj):
        return safe_value(obj, "is_used")

    @admin.display(description="Created At", ordering="created_at")
    def created_at_col(self, obj):
        return safe_value(obj, "created_at")

    @admin.display(description="Expires At", ordering="expires_at")
    def expires_at_col(self, obj):
        return safe_value(obj, "expires_at")

    def get_list_filter(self, request):
        filters = []
        for field in ("is_used", "created_at", "expires_at"):
            if has_field(self.model, field):
                filters.append(field)
        return tuple(filters)

    @admin.action(description="Mark selected OTPs as used")
    def mark_selected_as_used(self, request, queryset):
        if not has_field(queryset.model, "is_used"):
            self.message_user(request, "OTP model has no is_used field.", level=messages.WARNING)
            return
        updated = queryset.update(is_used=True)
        self.message_user(request, f"{updated} OTP(s) marked as used.", level=messages.SUCCESS)

    @admin.action(description="Delete expired OTPs")
    def delete_expired_otps(self, request, queryset):
        if not has_field(queryset.model, "expires_at"):
            self.message_user(request, "OTP model has no expires_at field.", level=messages.WARNING)
            return
        deleted_count, _ = queryset.model.objects.filter(expires_at__lt=timezone.now()).delete()
        self.message_user(request, f"{deleted_count} expired OTP(s) deleted.", level=messages.SUCCESS)


class KYCAdmin(admin.ModelAdmin):
    list_display = (
        "user_col",
        "document_col",
        "status_col",
        "upload_date_col",
        "reviewed_by_col",
        "rejection_reason_col",
    )
    actions = ("approve_kyc", "reject_kyc")
    ordering = ("-id",)

    @admin.display(description="User")
    def user_col(self, obj):
        return safe_value(obj, "user")

    @admin.display(description="Document")
    def document_col(self, obj):
        return safe_value(obj, first_field(obj.__class__, ["document", "document_file", "document_type"]))

    @admin.display(description="Status")
    def status_col(self, obj):
        return safe_value(obj, "status")

    @admin.display(description="Upload Date")
    def upload_date_col(self, obj):
        return safe_value(obj, first_field(obj.__class__, ["upload_date", "created_at", "submitted_at"]))

    @admin.display(description="Reviewed By")
    def reviewed_by_col(self, obj):
        return safe_value(obj, "reviewed_by")

    @admin.display(description="Rejection Reason")
    def rejection_reason_col(self, obj):
        return safe_value(obj, "rejection_reason")

    def get_list_filter(self, request):
        filters = []
        model = self.model
        if has_field(model, "status"):
            filters.append("status")
        upload_field = first_field(model, ["upload_date", "created_at", "submitted_at"])
        if upload_field:
            filters.append(upload_field)
        return tuple(filters)

    @admin.action(description="Approve KYC")
    def approve_kyc(self, request, queryset):
        updates = {}
        if has_field(queryset.model, "status"):
            updates["status"] = "approved"
        if has_field(queryset.model, "reviewed_by"):
            updates["reviewed_by"] = request.user
        updated = queryset.update(**updates) if updates else 0
        self.message_user(request, f"{updated} KYC request(s) approved.", level=messages.SUCCESS)

    @admin.action(description="Reject KYC with reason")
    def reject_kyc(self, request, queryset):
        updates = {}
        if has_field(queryset.model, "status"):
            updates["status"] = "rejected"
        if has_field(queryset.model, "reviewed_by"):
            updates["reviewed_by"] = request.user
        if has_field(queryset.model, "rejection_reason"):
            updates["rejection_reason"] = "Rejected by admin action"
        updated = queryset.update(**updates) if updates else 0
        self.message_user(
            request,
            f"{updated} KYC request(s) rejected. Edit individual records to provide custom rejection reasons.",
            level=messages.WARNING,
        )


class WalletAdmin(admin.ModelAdmin):
    list_display = (
        "user_col",
        "wallet_address_col",
        "balance_col",
        "total_deposits_col",
        "total_withdrawals_col",
    )
    ordering = ("-id",)

    @admin.display(description="User")
    def user_col(self, obj):
        return safe_value(obj, "user")

    @admin.display(description="Wallet Address")
    def wallet_address_col(self, obj):
        return safe_value(obj, first_field(obj.__class__, ["wallet_address", "address"]))

    @admin.display(description="Balance")
    def balance_col(self, obj):
        return safe_value(obj, "balance", default=Decimal("0"))

    @admin.display(description="Total Deposits")
    def total_deposits_col(self, obj):
        return safe_value(obj, "total_deposits", default=Decimal("0"))

    @admin.display(description="Total Withdrawals")
    def total_withdrawals_col(self, obj):
        return safe_value(obj, "total_withdrawals", default=Decimal("0"))

    def get_readonly_fields(self, request, obj=None):
        fields = list(super().get_readonly_fields(request, obj))
        protected = ("balance", "total_deposits", "total_withdrawals")
        for field in protected:
            if has_field(self.model, field):
                fields.append(field)
        return tuple(fields)


class TransactionAdmin(admin.ModelAdmin):
    list_display = (
        "transaction_id_col",
        "user_col",
        "amount_col",
        "transaction_type_col",
        "status_col",
        "timestamp_col",
    )
    ordering = ("-id",)

    @admin.display(description="Transaction ID")
    def transaction_id_col(self, obj):
        return safe_value(obj, first_field(obj.__class__, ["transaction_id", "reference_id", "id"]))

    @admin.display(description="User")
    def user_col(self, obj):
        return safe_value(obj, "user")

    @admin.display(description="Amount")
    def amount_col(self, obj):
        return safe_value(obj, "amount", default=Decimal("0"))

    @admin.display(description="Transaction Type")
    def transaction_type_col(self, obj):
        return safe_value(obj, "transaction_type")

    @admin.display(description="Status")
    def status_col(self, obj):
        return safe_value(obj, "status")

    @admin.display(description="Timestamp")
    def timestamp_col(self, obj):
        return safe_value(obj, first_field(obj.__class__, ["timestamp", "created_at", "date"]))

    def get_list_filter(self, request):
        model = self.model
        filters = []
        for field in ("transaction_type", "status"):
            if has_field(model, field):
                filters.append(field)
        date_field = first_field(model, ["timestamp", "created_at", "date"])
        if date_field:
            filters.append(date_field)
        return tuple(filters)

    def get_search_fields(self, request):
        model = self.model
        fields = []
        transaction_field = first_field(model, ["transaction_id", "reference_id", "reference"])
        if transaction_field:
            fields.append(transaction_field)
        if has_field(model, "user"):
            fields.extend(["user__username", "user__email"])
        return tuple(fields)


class TradeAdmin(admin.ModelAdmin):
    list_display = (
        "trade_id_col",
        "user_col",
        "coin_col",
        "market_type_col",
        "event_type_col",
        "price_col",
        "amount_col",
        "total_value_col",
        "profit_loss_col",
        "timestamp_col",
    )
    ordering = ("-id",)

    @admin.display(description="Trade ID")
    def trade_id_col(self, obj):
        return safe_value(obj, first_field(obj.__class__, ["trade_id", "reference_id", "id"]))

    @admin.display(description="User")
    def user_col(self, obj):
        return safe_value(obj, "user")

    @admin.display(description="Coin")
    def coin_col(self, obj):
        return safe_value(obj, "coin")

    @admin.display(description="Market")
    def market_type_col(self, obj):
        return safe_value(obj, "market_type")

    @admin.display(description="Event")
    def event_type_col(self, obj):
        return safe_value(obj, "event_type")

    @admin.display(description="Price")
    def price_col(self, obj):
        return safe_value(obj, "price", default=Decimal("0"))

    @admin.display(description="Amount")
    def amount_col(self, obj):
        return safe_value(obj, "amount", default=Decimal("0"))

    @admin.display(description="Total Value")
    def total_value_col(self, obj):
        if hasattr(obj, "total_value"):
            return obj.total_value
        price = getattr(obj, "price", Decimal("0"))
        amount = getattr(obj, "amount", Decimal("0"))
        return price * amount

    @admin.display(description="Profit/Loss")
    def profit_loss_col(self, obj):
        return safe_value(obj, first_field(obj.__class__, ["profit_loss", "pnl"]), default=Decimal("0"))

    @admin.display(description="Timestamp")
    def timestamp_col(self, obj):
        return safe_value(obj, first_field(obj.__class__, ["timestamp", "created_at", "date"]))

    def get_list_filter(self, request):
        model = self.model
        filters = []
        if has_field(model, "coin"):
            filters.append("coin")
        if has_field(model, "user"):
            filters.append("user")
        for field in ("market_type", "event_type", "side"):
            if has_field(model, field):
                filters.append(field)
        date_field = first_field(model, ["timestamp", "created_at", "date"])
        if date_field:
            filters.append(date_field)
        return tuple(filters)


class WalletAssetAdmin(admin.ModelAdmin):
    list_display = ("wallet_col", "symbol_col", "balance_col", "updated_at_col")
    ordering = ("symbol",)

    @admin.display(description="Wallet")
    def wallet_col(self, obj):
        return safe_value(obj, "wallet")

    @admin.display(description="Symbol")
    def symbol_col(self, obj):
        return safe_value(obj, "symbol")

    @admin.display(description="Balance")
    def balance_col(self, obj):
        return safe_value(obj, "balance", default=Decimal("0"))

    @admin.display(description="Updated At")
    def updated_at_col(self, obj):
        return safe_value(obj, "updated_at")


class PositionAdmin(admin.ModelAdmin):
    list_display = ("position_id_col", "user_col", "symbol_col", "market_type_col", "side_col", "status_col", "opened_at_col")
    ordering = ("-id",)

    @admin.display(description="Position ID")
    def position_id_col(self, obj):
        return safe_value(obj, "position_id")

    @admin.display(description="User")
    def user_col(self, obj):
        return safe_value(obj, "user")

    @admin.display(description="Symbol")
    def symbol_col(self, obj):
        return safe_value(obj, "symbol")

    @admin.display(description="Market")
    def market_type_col(self, obj):
        return safe_value(obj, "market_type")

    @admin.display(description="Side")
    def side_col(self, obj):
        return safe_value(obj, "side")

    @admin.display(description="Status")
    def status_col(self, obj):
        return safe_value(obj, "status")

    @admin.display(description="Opened At")
    def opened_at_col(self, obj):
        return safe_value(obj, "opened_at")


class CryptoCoinAdmin(admin.ModelAdmin):
    list_display = ("coin_name_col", "symbol_col", "price_col", "trading_status_col", "risk_level_col")
    ordering = ("symbol",)
    actions = ("enable_trading", "disable_trading", "update_price")

    @admin.display(description="Coin Name")
    def coin_name_col(self, obj):
        return safe_value(obj, first_field(obj.__class__, ["coin_name", "name"]))

    @admin.display(description="Symbol", ordering="symbol")
    def symbol_col(self, obj):
        return safe_value(obj, "symbol")

    @admin.display(description="Price")
    def price_col(self, obj):
        return safe_value(obj, "price", default=Decimal("0"))

    @admin.display(description="Trading Status")
    def trading_status_col(self, obj):
        if hasattr(obj, "trading_status"):
            return obj.trading_status
        return "active" if getattr(obj, "is_active", False) else "disabled"

    @admin.display(description="Risk Level")
    def risk_level_col(self, obj):
        return safe_value(obj, "risk_level")

    def get_list_filter(self, request):
        model = self.model
        filters = []
        for field in ("trading_status", "risk_level"):
            if has_field(model, field):
                filters.append(field)
        return tuple(filters)

    @admin.action(description="Enable trading")
    def enable_trading(self, request, queryset):
        updated = 0
        if has_field(queryset.model, "trading_status"):
            updated = queryset.update(trading_status="active")
        elif has_field(queryset.model, "is_active"):
            updated = queryset.update(is_active=True)
        self.message_user(request, f"Enabled trading for {updated} coin(s).", level=messages.SUCCESS)

    @admin.action(description="Disable trading")
    def disable_trading(self, request, queryset):
        updated = 0
        if has_field(queryset.model, "trading_status"):
            updated = queryset.update(trading_status="disabled")
        elif has_field(queryset.model, "is_active"):
            updated = queryset.update(is_active=False)
        self.message_user(request, f"Disabled trading for {updated} coin(s).", level=messages.WARNING)

    @admin.action(description="Update price")
    def update_price(self, request, queryset):
        model = queryset.model
        price_field = first_field(model, ["price", "current_price"])
        Trade = get_trade_model()
        if not price_field or not Trade or not has_field(Trade, "coin") or not has_field(Trade, "price"):
            self.message_user(
                request,
                "Price update skipped: required fields or Trade model data are unavailable.",
                level=messages.WARNING,
            )
            return

        updated = 0
        timestamp_field = first_field(model, ["updated_at", "last_updated"])
        for coin in queryset:
            latest_price = (
                Trade.objects.filter(coin=coin)
                .order_by("-timestamp", "-id")
                .values_list("price", flat=True)
                .first()
            )
            if latest_price is None:
                continue
            setattr(coin, price_field, latest_price)
            update_fields = [price_field]
            if timestamp_field:
                setattr(coin, timestamp_field, timezone.now())
                update_fields.append(timestamp_field)
            coin.save(update_fields=update_fields)
            updated += 1

        self.message_user(request, f"Updated price for {updated} coin(s).", level=messages.SUCCESS)


class SecurityLogAdmin(admin.ModelAdmin):
    list_display = ("user_col", "event_type_col", "ip_address_col", "timestamp_col")
    ordering = ("-id",)

    @admin.display(description="User")
    def user_col(self, obj):
        return safe_value(obj, "user")

    @admin.display(description="Event Type")
    def event_type_col(self, obj):
        return safe_value(obj, "event_type")

    @admin.display(description="IP Address")
    def ip_address_col(self, obj):
        return safe_value(obj, "ip_address")

    @admin.display(description="Timestamp")
    def timestamp_col(self, obj):
        return safe_value(obj, first_field(obj.__class__, ["timestamp", "created_at"]))

    def get_readonly_fields(self, request, obj=None):
        return tuple(field.name for field in self.model._meta.fields)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


class PlatformSettingsAdmin(admin.ModelAdmin):
    list_display = (
        "minimum_deposit_col",
        "maximum_trade_amount_col",
        "trading_fee_percent_col",
        "withdrawal_limit_col",
    )
    ordering = ("id",)

    @admin.display(description="Minimum Deposit")
    def minimum_deposit_col(self, obj):
        return safe_value(obj, "minimum_deposit")

    @admin.display(description="Maximum Trade Amount")
    def maximum_trade_amount_col(self, obj):
        return safe_value(obj, "maximum_trade_amount")

    @admin.display(description="Trading Fee Percent")
    def trading_fee_percent_col(self, obj):
        return safe_value(obj, "trading_fee_percent")

    @admin.display(description="Withdrawal Limit")
    def withdrawal_limit_col(self, obj):
        return safe_value(obj, "withdrawal_limit")


User = get_user_model()
register_or_replace(User, UserControlAdmin)
register_or_replace(get_model_by_name("OTP"), OTPAdmin)
register_or_replace(get_kyc_model(), KYCAdmin)
register_or_replace(get_wallet_model(), WalletAdmin)
register_or_replace(get_model_by_name("Transaction") or get_wallet_transaction_model(), TransactionAdmin)
register_or_replace(get_trade_model(), TradeAdmin)
register_or_replace(get_wallet_asset_model(), WalletAssetAdmin)
register_or_replace(get_position_model(), PositionAdmin)
register_or_replace(get_model_by_name("CryptoCoin"), CryptoCoinAdmin)
register_or_replace(get_model_by_name("SecurityLog"), SecurityLogAdmin)
register_or_replace(get_model_by_name("PlatformSettings"), PlatformSettingsAdmin)
