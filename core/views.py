import random
import logging
import traceback
from datetime import timedelta
from decimal import Decimal

from django.core.exceptions import PermissionDenied
from django.contrib.auth import authenticate, get_user_model, login as auth_login, logout as auth_logout
from django.contrib.auth.hashers import check_password, make_password
from django.contrib.auth.password_validation import validate_password
from django.conf import settings
from django.http import HttpResponse, HttpResponseBadRequest, JsonResponse
import requests
from django.shortcuts import redirect, render
from django.utils import timezone
from django.views import View
from django.db import transaction
from django.db.models import Sum
from django.db.models.functions import Coalesce

from accounts.models import OTP
from accounts.models import Position, Wallet, WalletTransaction, Trade
from core.serializers import (
    PortfolioSummarySerializer,
    PositionSerializer,
    TradeSerializer,
    WalletSerializer,
    WalletTransactionSerializer,
)
from core.email_service import send_otp_email

User = get_user_model()
logger = logging.getLogger(__name__)


def _normalize_asset_symbol(value: str | None) -> str:
    symbol = (value or 'USDT').upper().strip()
    if symbol.endswith('USDT') and len(symbol) > 4:
        return symbol[:-4]
    return symbol


def _ensure_wallet(user):
    wallet, _ = Wallet.objects.get_or_create(user=user)
    if not wallet.wallet_address:
        wallet.save()
    return wallet


def _wallet_transaction_to_history_row(tx: WalletTransaction):
    amount_text = f"+{tx.amount}" if tx.tx_type == 'deposit' else f"-{tx.amount}"
    return {
        "kind": "wallet_transaction",
        "time": tx.created_at.isoformat() if tx.created_at else None,
        "transaction": {
            "time": tx.created_at.isoformat() if tx.created_at else None,
            "asset": tx.asset,
            "type": tx.get_tx_type_display(),
            "amount": amount_text,
            "status": tx.status.capitalize(),
            "details": tx.details or f"{tx.get_tx_type_display()} {tx.asset}",
        },
    }


def _create_trade_id():
    import uuid

    trade_id = str(uuid.uuid4())[:8]
    while Trade.objects.filter(trade_id=trade_id).exists():
        trade_id = str(uuid.uuid4())[:8]
    return trade_id


def _record_trade(*, user, coin, side, price, amount, total_value, market_type, event_type, profit_loss=Decimal("0")):
    return Trade.objects.create(
        user=user,
        trade_id=_create_trade_id(),
        coin=coin,
        side=side,
        price=price,
        amount=amount,
        total_value=total_value,
        profit_loss=profit_loss,
        market_type=market_type,
        event_type=event_type,
    )


def debug_health(request):
    """Diagnostic endpoint to check production systems. Visit /debug/health/ on Render."""
    checks = {}
    
    # 1. Check database connection
    try:
        from django.db import connection
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        checks['database'] = '✅ Connected'
    except Exception as e:
        checks['database'] = f'❌ {e}'
    
    # 2. Check OTP table exists
    try:
        count = OTP.objects.count()
        checks['otp_table'] = f'✅ Exists ({count} records)'
    except Exception as e:
        checks['otp_table'] = f'❌ {e}'
    
    # 3. Check User table
    try:
        count = User.objects.count()
        checks['user_table'] = f'✅ Exists ({count} users)'
    except Exception as e:
        checks['user_table'] = f'❌ {e}'
    
    # 4. Check email config
    checks['email_host'] = getattr(settings, 'EMAIL_HOST', 'NOT SET')
    checks['email_port'] = getattr(settings, 'EMAIL_PORT', 'NOT SET')
    checks['email_user'] = getattr(settings, 'EMAIL_HOST_USER', 'NOT SET')
    checks['email_pass_len'] = len(getattr(settings, 'EMAIL_HOST_PASSWORD', ''))
    checks['email_from'] = getattr(settings, 'DEFAULT_FROM_EMAIL', 'NOT SET')
    checks['email_backend'] = getattr(settings, 'EMAIL_BACKEND', 'NOT SET')
    
    # 5. Check static files
    checks['static_storage'] = getattr(settings, 'STATICFILES_STORAGE', 'NOT SET')
    checks['debug'] = getattr(settings, 'DEBUG', 'NOT SET')
    checks['allowed_hosts'] = getattr(settings, 'ALLOWED_HOSTS', [])
    checks['csrf_origins'] = getattr(settings, 'CSRF_TRUSTED_ORIGINS', [])
    
    # 6. Check template rendering
    try:
        from django.template.loader import render_to_string
        render_to_string('emails/otp/verification.html', {'otp_code': '123456'})
        checks['email_template'] = '✅ Renders OK'
    except Exception as e:
        checks['email_template'] = f'❌ {e}'
    
    # 7. Try rendering verify_otp template
    try:
        from django.template.loader import render_to_string
        render_to_string('core/signup/verify_otp.html', {'email': 'test@test.com'})
        checks['otp_page_template'] = '✅ Renders OK'
    except Exception as e:
        checks['otp_page_template'] = f'❌ {e}'
    
    # Format output
    lines = ['=== NexusCrypto Health Check ===\n']
    for key, val in checks.items():
        lines.append(f'{key}: {val}')
    
    return HttpResponse('\n'.join(lines), content_type='text/plain')



def _create_otp_for_email(email):
    """Generate a 6-digit OTP for email, store hashed version, return plain code for sending."""
    code = ''.join(str(random.randint(0, 9)) for _ in range(6))
    otp_hash = make_password(code)
    expires_at = timezone.now() + timedelta(minutes=10)  # 10 minutes expiry
    
    # Create OTP record
    OTP.objects.create(
        email=email,
        otp_hash=otp_hash,
        expires_at=expires_at,
        user=None  # Explicitly set to None since user doesn't exist yet
    )
    
    return code


def index(request):
    """Landing page."""
    return render(request, 'core/index.html')


class SignupEmailView(View):
    """Step 1: collect email, store in session, redirect to password step."""

    def get(self, request):
        return render(request, 'core/login.html')

    def post(self, request):
        email = (request.POST.get('email') or '').strip().lower()
        terms = request.POST.get('terms') == 'on'

        if not email:
            return render(request, 'core/login.html', {
                'error': 'Please enter your email.',
                'email': request.POST.get('email', ''),
            })

        if not terms:
            return render(request, 'core/login.html', {
                'error': 'You must agree to the Terms and Privacy Policy.',
                'email': email,
            })

        if User.objects.filter(email=email).exists():
            request.session['signin_hint_email'] = email
            return redirect('login')

        request.session['signup_email'] = email
        return redirect('signup_password')


class SignupPasswordView(View):
    """Step 2: set password, store in session, create OTP for email, send email, redirect to verify OTP."""

    def get(self, request):
        email = request.session.get('signup_email')
        if not email:
            return redirect('signup')
        return render(request, 'core/signup/passwordpage.html', {'email': email})

    def post(self, request):
        try:
            email = request.session.get('signup_email')
            if not email:
                return redirect('signup')

            # Validate email format
            from django.core.validators import validate_email
            from django.core.exceptions import ValidationError
            try:
                validate_email(email)
            except ValidationError:
                return render(request, 'core/signup/passwordpage.html', {
                    'email': email,
                    'errors': ['Invalid email address format.'],
                })

            password1 = request.POST.get('password1', '')
            password2 = request.POST.get('password2', '')

            errors = []
            if not password1:
                errors.append('Password is required.')
            elif password1 != password2:
                errors.append('The two password fields did not match.')
            else:
                try:
                    validate_password(password1, User(email=email))
                except Exception as e:
                    errors.extend(list(e.messages))

            if errors:
                return render(request, 'core/signup/passwordpage.html', {
                    'email': email,
                    'errors': errors,
                })

            # Store password in session temporarily
            request.session['signup_email'] = email
            request.session['signup_password_plain'] = password1
            
            # Generate OTP for email and send email
            try:
                code = _create_otp_for_email(email)
                email_sent = send_otp_email(email, code)
            except Exception as e:
                logger.error(f"OTP create/send failed: {traceback.format_exc()}")
                err_lower = str(e).lower()
                user_error = 'Failed to generate OTP. Please try again.'
                if 'database' in err_lower or 'migration' in err_lower:
                    user_error = 'Database error. Please contact support.'
                elif 'email' in err_lower or 'invalid' in err_lower:
                    user_error = 'Invalid email address. Please check and try again.'
                
                return render(request, 'core/signup/passwordpage.html', {
                    'email': email,
                    'errors': [user_error],
                })
            
            # Ensure session is saved before redirect
            request.session.modified = True
            try:
                request.session.save()
            except Exception:
                pass
            
            return redirect('signup_verify_otp')
        except Exception as e:
            # CATCH-ALL: Log the full traceback so it shows in Render logs
            logger.error(f"SignupPasswordView.post CRASH: {traceback.format_exc()}")
            return render(request, 'core/signup/passwordpage.html', {
                'email': request.session.get('signup_email', ''),
                'errors': [f'Unexpected error: {e.__class__.__name__}: {e}'],
            })


class SigninView(View):
    """Temporary sign-in page for existing users."""

    def get(self, request):
        if request.user.is_authenticated:
            return redirect('dashboard')

        email = (request.GET.get('email') or request.session.pop('signin_hint_email', '')).strip().lower()
        return render(request, 'core/signin.html', {'email': email})

    def post(self, request):
        email = (request.POST.get('email') or '').strip().lower()
        password = request.POST.get('password') or ''

        if not email or not password:
            return render(request, 'core/signin.html', {
                'email': email,
                'error': 'Please enter both email and password.',
            })

        # django-axes: attempt authentication — may raise AxesLockedOut
        try:
            # Resolve user with case-insensitive lookup so mixed-case stored emails can still sign in.
            candidate = User.objects.filter(email__iexact=email).first() or User.objects.filter(username__iexact=email).first()
            login_identifier = candidate.email if candidate else email

            user = authenticate(request, email=login_identifier, password=password)
            if not user:
                # Temporary fallback to support projects/users that still authenticate with username.
                user = authenticate(request, username=login_identifier, password=password)
            if not user and candidate and candidate.check_password(password):
                # Final fallback for legacy auth edge cases.
                user = candidate
        except PermissionDenied:
            return render(request, 'core/signin.html', {
                'email': email,
                'error': 'Too many failed login attempts. Your account is temporarily locked. Please try again after 30 minutes.',
            })

        if not user:
            return render(request, 'core/signin.html', {
                'email': email,
                'error': 'Invalid email or password.',
            })

        if not user.is_active:
            return render(request, 'core/signin.html', {
                'email': email,
                'error': 'This account is inactive. Please contact support.',
            })

        if not hasattr(user, 'backend'):
            user.backend = 'django.contrib.auth.backends.ModelBackend'
        auth_login(request, user)
        # Ensure wallet always exists for authenticated users.
        _ensure_wallet(user)
        return redirect('dashboard')


class SignupVerifyOtpView(View):
    """Step 3: verify OTP, THEN create user account, link OTP to user, login and redirect to welcome screen."""

    def get(self, request):
        email = request.session.get('signup_email')
        plain_password = request.session.get('signup_password_plain')
        
        if not email or not plain_password:
            return redirect('signup')
        
        # Check if user already exists (shouldn't happen, but safety check)
        if User.objects.filter(email=email).exists():
            request.session.flush()
            return redirect('login')
        
        context = {'email': email}
        
        return render(request, 'core/signup/verify_otp.html', context)

    def post(self, request):
        email = request.session.get('signup_email')
        plain_password = request.session.get('signup_password_plain')
        if not email or not plain_password:
            return redirect('signup')
        
        # Check if user already exists (shouldn't happen, but safety check)
        if User.objects.filter(email=email).exists():
            request.session.flush()
            return redirect('login')

        otp_value = (request.POST.get('otp') or '').strip()
        if len(otp_value) != 6 or not otp_value.isdigit():
            return render(request, 'core/signup/verify_otp.html', {
                'email': email,
                'error': 'Please enter a valid 6-digit code.',
            })

        # OTP rate limiting — max 5 wrong attempts per signup session
        otp_attempts = request.session.get('otp_attempts', 0)
        if otp_attempts >= 5:
            return render(request, 'core/signup/verify_otp.html', {
                'email': email,
                'error': 'Too many failed OTP attempts. Please request a new code.',
            })

        # Verify OTP using email (not user, since user doesn't exist yet)
        now = timezone.now()
        otp_record = (
            OTP.objects.filter(email=email, is_used=False, expires_at__gt=now, user__isnull=True)
            .order_by('-created_at')
            .first()
        )
        
        if not otp_record or not check_password(otp_value, otp_record.otp_hash):
            request.session['otp_attempts'] = otp_attempts + 1
            remaining = 5 - (otp_attempts + 1)
            return render(request, 'core/signup/verify_otp.html', {
                'email': email,
                'error': f'Invalid or expired code. {remaining} attempt(s) remaining.',
            })

        # OTP verified! Now create the user account
        # Create user account
        user = User.objects.create_user(
            email=email,
            password=plain_password,
            username=email,
        )
        # Auto-create wallet on signup so DB has row immediately.
        _ensure_wallet(user)
        
        # Link OTP to user
        otp_record.user = user
        otp_record.is_used = True
        otp_record.save(update_fields=['user', 'is_used'])
        
        # Clear signup info and mark that we should show the welcome screen once.
        for key in ('signup_email', 'signup_password_plain'):
            request.session.pop(key, None)
        request.session['show_welcome'] = True
        auth_login(request, user)
        return redirect('welcome')


class SignupResendOtpView(View):
    """Resend OTP for the email in signup session."""

    def get(self, request):
        return self._resend(request)

    def post(self, request):
        return self._resend(request)

    def _resend(self, request):
        email = request.session.get('signup_email')
        plain_password = request.session.get('signup_password_plain')
        if not email or not plain_password:
            return redirect('signup')
        
        # Check if user already exists (shouldn't happen during signup)
        if User.objects.filter(email=email).exists():
            request.session.flush()
            return redirect('login')
        
        # Generate new OTP for email and send email
        code = _create_otp_for_email(email)
        
        # Reset OTP attempt counter on resend
        request.session['otp_attempts'] = 0
        
        # Send OTP email
        send_otp_email(email, code)
        
        return redirect('signup_verify_otp')


class WelcomeView(View):
    """One-time welcome screen shown right after successful signup."""

    def get(self, request):
        if not request.user.is_authenticated:
            return redirect('login')

        # Only show immediately after signup when the flag is present.
        show = request.session.pop('show_welcome', False)
        if not show:
            return redirect('index')

        return render(request, 'core/welcome.html')


class DashboardView(View):
    """Main user dashboard."""

    def get(self, request):
        if not request.user.is_authenticated:
            return redirect('login')
        allowed_views = {
            "overview",
            "trade",
            "fiat",
            "margin",
            "futures",
            "history",
            "earn",
            "security",
            "identification",
            "api",
        }
        active_view = (request.GET.get("view") or "overview").strip().lower()
        if active_view not in allowed_views:
            active_view = "overview"
        return render(request, 'core/dashboard.html', {
            'COINAPI_API_KEY': getattr(settings, 'COINAPI_API_KEY', ''),
            'active_view': active_view,
        })


class MarketView(View):
    """Market analytics page."""

    def get(self, request):
        if not request.user.is_authenticated:
            return redirect('login')
        return render(request, 'core/market.html')


class DepositMethodsView(View):
    """Deposit methods page."""

    def get(self, request):
        if not request.user.is_authenticated:
            return redirect('login')
        return render(request, 'core/deposit_methods.html')


class LogoutView(View):
    """Log user out and redirect to login."""

    def post(self, request):
        auth_logout(request)
        return redirect('login')
# region binance proxy
import json as _jsonlib
import urllib.parse as _urlparse
import urllib.request as _urlrequest

_BINANCE_BASE = "https://api.binance.com"
_COINGECKO_BASE = "https://api.coingecko.com/api/v3"


def _proxy_binance(path: str, params: dict | None = None):
    try:
        query = _urlparse.urlencode(params or {})
        url = f"{_BINANCE_BASE}{path}"
        if query:
            url = f"{url}?{query}"
        headers = {
            "Accept": "application/json",
            "User-Agent": "NexusCrypto/1.0",
        }
        api_key = getattr(settings, "BINANCE_API_KEY", "")
        if api_key:
            headers["X-MBX-APIKEY"] = api_key
        req = _urlrequest.Request(url, headers=headers)
        with _urlrequest.urlopen(req, timeout=10) as resp:
            data = resp.read()
            content_type = resp.headers.get("Content-Type", "application/json")
            return HttpResponse(data, content_type=content_type)
    except Exception:
        return JsonResponse({"error": "binance_unavailable"}, status=502)

def _proxy_coingecko(path: str, params: dict | None = None):
    try:
        query = _urlparse.urlencode(params or {})
        url = f"{_COINGECKO_BASE}{path}"
        if query:
            url = f"{url}?{query}"
        headers = {
            "Accept": "application/json",
            "User-Agent": "NexusCrypto/1.0",
        }
        req = _urlrequest.Request(url, headers=headers)
        with _urlrequest.urlopen(req, timeout=12) as resp:
            data = resp.read()
            content_type = resp.headers.get("Content-Type", "application/json")
            return HttpResponse(data, content_type=content_type)
    except Exception:
        return JsonResponse({"error": "coingecko_unavailable"}, status=502)


def binance_exchange_info(request):
    return _proxy_binance("/api/v3/exchangeInfo")


def binance_ticker_24hr(request):
    symbol = (request.GET.get("symbol") or "").upper().strip()
    params = {"symbol": symbol} if symbol else None
    return _proxy_binance("/api/v3/ticker/24hr", params)

def binance_ping(request):
    return _proxy_binance("/api/v3/ping")


def binance_depth(request):
    symbol = (request.GET.get("symbol") or "").upper().strip()
    if not symbol:
        return HttpResponseBadRequest(_jsonlib.dumps({"error": "symbol_required"}), content_type="application/json")
    limit = request.GET.get("limit") or "6"
    try:
        limit_val = max(1, min(100, int(limit)))
    except ValueError:
        return HttpResponseBadRequest(_jsonlib.dumps({"error": "limit_invalid"}), content_type="application/json")
    return _proxy_binance("/api/v3/depth", {"symbol": symbol, "limit": limit_val})


def binance_klines(request):
    symbol = (request.GET.get("symbol") or "").upper().strip()
    interval = (request.GET.get("interval") or "").strip()
    if not symbol or not interval:
        return HttpResponseBadRequest(_jsonlib.dumps({"error": "symbol_interval_required"}), content_type="application/json")
    limit = request.GET.get("limit") or "200"
    try:
        limit_val = max(1, min(1000, int(limit)))
    except ValueError:
        return HttpResponseBadRequest(_jsonlib.dumps({"error": "limit_invalid"}), content_type="application/json")
    return _proxy_binance("/api/v3/klines", {"symbol": symbol, "interval": interval, "limit": limit_val})

# CoinGecko proxy endpoints
def coingecko_markets(request):
    vs_currency = (request.GET.get("vs_currency") or "usd").lower()
    per_page = request.GET.get("per_page") or "120"
    page = request.GET.get("page") or "1"
    sparkline = request.GET.get("sparkline") or "false"
    price_change = request.GET.get("price_change_percentage") or "24h"
    return _proxy_coingecko(
        "/coins/markets",
        {
            "vs_currency": vs_currency,
            "order": "market_cap_desc",
            "per_page": per_page,
            "page": page,
            "sparkline": sparkline,
            "price_change_percentage": price_change,
        },
    )


def coingecko_simple_price(request):
    ids = request.GET.get("ids") or ""
    vs = (request.GET.get("vs_currencies") or "usd").lower()
    include_change = request.GET.get("include_24hr_change") or "true"
    return _proxy_coingecko(
        "/simple/price",
        {"ids": ids, "vs_currencies": vs, "include_24hr_change": include_change},
    )


def coingecko_market_chart(request):
    coin_id = request.GET.get("id") or ""
    if not coin_id:
        return HttpResponseBadRequest(_jsonlib.dumps({"error": "id_required"}), content_type="application/json")
    vs = (request.GET.get("vs_currency") or "usd").lower()
    days = request.GET.get("days") or "1"
    interval = request.GET.get("interval") or "minutely"
    return _proxy_coingecko(
        f"/coins/{coin_id}/market_chart",
        {"vs_currency": vs, "days": days, "interval": interval},
    )

# Simple inline favicon to avoid 404 noise in console.
def favicon(request):
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'>"
        "<rect width='64' height='64' rx='14' fill='#0b0e11'/>"
        "<path d='M20 44L32 12l12 32h-6l-2.6-7H28.6L26 44z' fill='#f0b90b'/>"
        "</svg>"
    )
    return HttpResponse(svg, content_type="image/svg+xml")

# endregion binance proxy


def candles(request):
    url = "https://api.binance.com/api/v3/klines"
    params = {
        "symbol": "BTCUSDT",
        "interval": "5m",
        "limit": 200,
    }
    try:
        resp = requests.get(url, params=params, timeout=10)
        data = resp.json()
        return JsonResponse(data, safe=False)
    except Exception:
        # Fallback to CoinGecko market chart
        try:
            resp = requests.get(
                "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart",
                params={"vs_currency": "usd", "days": "1", "interval": "minutely"},
                timeout=10,
            )
            payload = resp.json()
            prices = payload.get("prices", [])
            # Convert price points to kline-like rows
            rows = [[p[0], p[1], p[1], p[1], p[1], 0] for p in prices[-200:]]
            return JsonResponse(rows, safe=False)
        except Exception:
            return JsonResponse({"error": "candles_unavailable"}, status=502)


def ticker(request):
    try:
        resp = requests.get("https://api.binance.com/api/v3/ticker/24hr", params={"symbol": "BTCUSDT"}, timeout=10)
        data = resp.json()
        price = data.get("lastPrice")
        change = data.get("priceChangePercent")
        high = data.get("highPrice")
        low = data.get("lowPrice")
        volume = data.get("volume")
        quote_volume = data.get("quoteVolume")
        return JsonResponse({
            "price": float(price),
            "change": float(change),
            "high": float(high),
            "low": float(low),
            "volume": float(volume),
            "quoteVolume": float(quote_volume),
        })
    except Exception:
        try:
            resp = requests.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": "bitcoin", "vs_currencies": "usd", "include_24hr_change": "true"},
                timeout=10,
            )
            payload = resp.json().get("bitcoin", {})
            price = payload.get("usd", 0)
            change = payload.get("usd_24h_change", 0)
            return JsonResponse({
                "price": float(price),
                "change": float(change),
                "high": float(price),
                "low": float(price),
                "volume": 0,
                "quoteVolume": 0,
            })
        except Exception:
            return JsonResponse({"price": 0, "change": 0, "high": 0, "low": 0, "volume": 0, "quoteVolume": 0}, status=502)


def orderbook(request):
    try:
        resp = requests.get("https://api.binance.com/api/v3/depth", params={"symbol": "BTCUSDT", "limit": 20}, timeout=10)
        data = resp.json()
        return JsonResponse({"asks": data.get("asks", []), "bids": data.get("bids", [])})
    except Exception:
        # Fallback: build synthetic book around last price
        try:
            price_resp = requests.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": "bitcoin", "vs_currencies": "usd"},
                timeout=10,
            )
            base = float(price_resp.json().get("bitcoin", {}).get("usd", 0) or 0) or 1
            asks = []
            bids = []
            for i in range(1, 21):
                asks.append([f"{base + (i * base * 0.0006):.2f}", f"{0.001 + i * 0.0002:.6f}"])
                bids.append([f"{base - (i * base * 0.0006):.2f}", f"{0.001 + i * 0.0002:.6f}"])
            return JsonResponse({"asks": asks, "bids": bids})
        except Exception:
            return JsonResponse({"asks": [], "bids": []}, status=502)


def wallet_data(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "unauthorized", "message": "Please log in to access wallet data."}, status=401)

    wallet = _ensure_wallet(request.user)
    serializer = WalletSerializer(wallet=wallet, user=request.user)
    return JsonResponse(serializer.data)


def portfolio_summary(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "unauthorized", "message": "Please log in to access portfolio data."}, status=401)

    wallet = _ensure_wallet(request.user)
    user_trades = Trade.objects.filter(user=request.user)
    trade_count = user_trades.count()
    total_volume = user_trades.aggregate(volume=Coalesce(Sum("total_value"), Decimal("0")))["volume"]
    serializer = PortfolioSummarySerializer(wallet=wallet, trade_count=trade_count, total_volume=total_volume)
    return JsonResponse(serializer.data)


def transactions_data(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "unauthorized", "message": "Please log in to access transaction data."}, status=401)

    limit_raw = request.GET.get("limit", "100")
    try:
        limit = max(1, min(500, int(limit_raw)))
    except ValueError:
        return JsonResponse({"error": "invalid_limit"}, status=400)

    trades_qs = list(
        Trade.objects
        .select_related("user")
        .filter(user=request.user)
        .order_by("-timestamp")[:limit]
    )
    wallet_txs_qs = list(
        WalletTransaction.objects
        .filter(user=request.user)
        .order_by("-created_at")[:limit]
    )
    merged = []
    for trade in trades_qs:
        item = TradeSerializer(trade).data
        item["_sort_key"] = trade.timestamp
        merged.append(item)
    for tx in wallet_txs_qs:
        item = WalletTransactionSerializer(tx).data
        item["history_rows"] = _wallet_transaction_to_history_row(tx)
        item["_sort_key"] = tx.created_at
        merged.append(item)
    merged.sort(key=lambda item: item.get("_sort_key") or timezone.now(), reverse=True)
    results = [{k: v for k, v in item.items() if k != "_sort_key"} for item in merged[:limit]]
    return JsonResponse({"results": results, "count": len(results)})


def positions_data(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "unauthorized", "message": "Please log in to access positions."}, status=401)

    positions = Position.objects.filter(user=request.user, status='open').order_by('-opened_at')
    margin = [PositionSerializer(pos).data for pos in positions if pos.market_type == 'margin']
    futures = [PositionSerializer(pos).data for pos in positions if pos.market_type == 'futures']
    return JsonResponse({"margin": margin, "futures": futures})


def deposit_simulate(request):
    if request.method != "POST":
        return JsonResponse({"error": "method_not_allowed"}, status=405)
    if not request.user.is_authenticated:
        return JsonResponse({"error": "unauthorized", "message": "Please log in to deposit."}, status=401)

    try:
        import json

        payload = json.loads(request.body.decode("utf-8") or "{}")
        amount = Decimal(str(payload.get("amount", 0)))
        asset = _normalize_asset_symbol(payload.get("asset"))
        method = str(payload.get("method", "")).strip()[:120]
        if amount <= 0:
            return JsonResponse({"error": "invalid_amount"}, status=400)

        with transaction.atomic():
            wallet, _ = Wallet.objects.select_for_update().get_or_create(user=request.user)
            if not wallet.wallet_address:
                wallet.save()
            current_balance = wallet.get_asset_balance(asset)
            wallet.set_asset_balance(asset, current_balance + amount)
            wallet.total_deposits += amount
            wallet.save(update_fields=["total_deposits"])

            tx = WalletTransaction.objects.create(
                wallet=wallet,
                user=request.user,
                tx_type="deposit",
                asset=asset,
                amount=amount,
                method=method,
                details=f"{method or asset} deposit credited to {asset} wallet",
            )

        return JsonResponse({
            "status": "ok",
            "wallet": WalletSerializer(wallet=wallet, user=request.user).data,
            "transaction": WalletTransactionSerializer(tx).data,
            "history_rows": _wallet_transaction_to_history_row(tx),
        })
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=400)


def margin_order(request):
    if request.method != "POST":
        return JsonResponse({"error": "method_not_allowed"}, status=405)
    if not request.user.is_authenticated:
        return JsonResponse({"error": "unauthorized", "message": "Please log in to trade margin."}, status=401)

    try:
        import json

        payload = json.loads(request.body.decode("utf-8") or "{}")
        side = str(payload.get("side", "")).lower().strip()
        symbol = str(payload.get("symbol", "BTCUSDT")).upper().strip() or "BTCUSDT"
        price = Decimal(str(payload.get("price", 0)))
        size = Decimal(str(payload.get("size", 0)))
        leverage = Decimal(str(payload.get("leverage", 1)))
        if side not in {"long", "short"}:
            return JsonResponse({"error": "invalid_side"}, status=400)
        if price <= 0 or size <= 0 or leverage <= 0:
            return JsonResponse({"error": "invalid_parameters"}, status=400)

        margin_required = (price * size) / leverage

        with transaction.atomic():
            wallet, _ = Wallet.objects.select_for_update().get_or_create(user=request.user)
            if wallet.balance < margin_required:
                return JsonResponse(
                    {"error": "insufficient_balance", "required": float(margin_required), "available": float(wallet.balance)},
                    status=400,
                )
            wallet.balance -= margin_required
            wallet.save(update_fields=["balance"])

            position = Position.objects.create(
                user=request.user,
                wallet=wallet,
                symbol=symbol,
                market_type="margin",
                side=side,
                amount=size,
                entry_price=price,
                leverage=leverage,
                margin=margin_required,
            )
            trade = _record_trade(
                user=request.user,
                coin=symbol,
                side=side.capitalize(),
                price=price,
                amount=size,
                total_value=margin_required,
                market_type="margin",
                event_type="margin_open",
            )

        return JsonResponse({
            "status": "ok",
            "trade": TradeSerializer(trade).data,
            "position": PositionSerializer(position).data,
            "new_usdt": float(wallet.balance),
        })
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=400)


def margin_close_all(request):
    if request.method != "POST":
        return JsonResponse({"error": "method_not_allowed"}, status=405)
    if not request.user.is_authenticated:
        return JsonResponse({"error": "unauthorized", "message": "Please log in to close margin positions."}, status=401)

    try:
        import json

        payload = json.loads(request.body.decode("utf-8") or "{}")
        symbol = str(payload.get("symbol", "BTCUSDT")).upper().strip() or "BTCUSDT"
        close_price = Decimal(str(payload.get("close_price", 0)))
        if close_price <= 0:
            return JsonResponse({"error": "invalid_close_price"}, status=400)

        total_released = Decimal("0")
        closed_count = 0
        now = timezone.now()

        with transaction.atomic():
            wallet, _ = Wallet.objects.select_for_update().get_or_create(user=request.user)
            positions = list(Position.objects.select_for_update().filter(
                user=request.user,
                market_type='margin',
                status='open',
                symbol=symbol,
            ))
            for position in positions:
                pnl = (close_price - position.entry_price) * position.amount if position.side == 'long' else (position.entry_price - close_price) * position.amount
                released = position.margin + pnl
                total_released += released
                position.status = 'closed'
                position.close_price = close_price
                position.realized_pnl = pnl
                position.closed_at = now
                position.save(update_fields=['status', 'close_price', 'realized_pnl', 'closed_at'])
                _record_trade(
                    user=request.user,
                    coin=position.symbol,
                    side='Close',
                    price=close_price,
                    amount=position.amount,
                    total_value=released,
                    profit_loss=pnl,
                    market_type='margin',
                    event_type='margin_close',
                )
                closed_count += 1

            wallet.balance += total_released
            wallet.save(update_fields=['balance'])

        return JsonResponse({
            "status": "ok",
            "closed_count": closed_count,
            "released_total": float(total_released),
            "new_usdt": float(wallet.balance),
        })
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=400)

def order(request):
    if request.method != "POST":
        return JsonResponse({"error": "method_not_allowed"}, status=405)
    
    if not request.user.is_authenticated:
        return JsonResponse({"error": "unauthorized", "message": "Please log in to trade."}, status=401)

    try:
        import json
        payload = json.loads(request.body.decode("utf-8") or "{}")
        side = payload.get("side", "").lower()
        symbol = str(payload.get("symbol", "BTCUSDT")).upper().strip() or "BTCUSDT"
        asset_symbol = _normalize_asset_symbol(symbol)
        price = Decimal(str(payload.get("price", 0)))
        size = Decimal(str(payload.get("size", 0)))
        
        if size <= 0 or price <= 0:
            return JsonResponse({"error": "invalid_parameters"}, status=400)
            
        with transaction.atomic():
            wallet, _ = Wallet.objects.select_for_update().get_or_create(user=request.user)
            total_value = price * size

            if side == "buy":
                if wallet.balance < total_value:
                    return JsonResponse({"error": "insufficient_balance", "required": float(total_value), "available": float(wallet.balance)}, status=400)

                wallet.balance -= total_value
                wallet.save(update_fields=["balance"])
                current_asset = wallet.get_asset_balance(asset_symbol)
                wallet.set_asset_balance(asset_symbol, current_asset + size)

            elif side == "sell":
                current_asset = wallet.get_asset_balance(asset_symbol)
                if current_asset < size:
                    return JsonResponse({"error": "insufficient_crypto", "required": float(size), "available": float(current_asset)}, status=400)

                wallet.set_asset_balance(asset_symbol, current_asset - size)
                wallet.balance += total_value
                wallet.save(update_fields=["balance"])
            else:
                return JsonResponse({"error": "invalid_side"}, status=400)

            import uuid
            trade_id = str(uuid.uuid4())[:8]
            while Trade.objects.filter(trade_id=trade_id).exists():
                trade_id = str(uuid.uuid4())[:8]

            trade = Trade.objects.create(
                user=request.user,
                trade_id=trade_id,
                coin=symbol,
                side=side.capitalize(),
                price=price,
                amount=size,
                total_value=total_value,
                market_type="spot",
                event_type="spot_fill",
            )

        return JsonResponse({
            "status": "ok",
            "side": side,
            "price": float(price),
            "size": float(size),
            "trade_id": trade.trade_id,
            "user_id": request.user.id,
            "user_email": request.user.email,
            "trade": TradeSerializer(trade).data,
            "new_usdt": float(wallet.balance),
            "asset_symbol": asset_symbol,
            "new_asset_balance": float(wallet.get_asset_balance(asset_symbol)),
        })
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=400)


def futures_order(request):
    if request.method != "POST":
        return JsonResponse({"error": "method_not_allowed"}, status=405)
    if not request.user.is_authenticated:
        return JsonResponse({"error": "unauthorized", "message": "Please log in to trade futures."}, status=401)

    try:
        import json
        payload = json.loads(request.body.decode("utf-8") or "{}")
        side = str(payload.get("side", "")).lower().strip()
        symbol = str(payload.get("symbol", "BTCUSDT")).upper().strip() or "BTCUSDT"
        price = Decimal(str(payload.get("price", 0)))
        size = Decimal(str(payload.get("size", 0)))
        leverage = Decimal(str(payload.get("leverage", 1)))

        if side not in {"long", "short"}:
            return JsonResponse({"error": "invalid_side"}, status=400)
        if price <= 0 or size <= 0 or leverage <= 0:
            return JsonResponse({"error": "invalid_parameters"}, status=400)

        margin_required = (price * size) / leverage

        with transaction.atomic():
            wallet, _ = Wallet.objects.select_for_update().get_or_create(user=request.user)
            if wallet.balance < margin_required:
                return JsonResponse(
                    {
                        "error": "insufficient_balance",
                        "required": float(margin_required),
                        "available": float(wallet.balance),
                    },
                    status=400,
                )

            wallet.balance -= margin_required
            wallet.save(update_fields=["balance"])

            position = Position.objects.create(
                user=request.user,
                wallet=wallet,
                symbol=symbol,
                market_type="futures",
                side=side,
                amount=size,
                entry_price=price,
                leverage=leverage,
                margin=margin_required,
                take_profit=Decimal(str(payload.get("tp", 0))) if Decimal(str(payload.get("tp", 0))) > 0 else None,
                stop_loss=Decimal(str(payload.get("sl", 0))) if Decimal(str(payload.get("sl", 0))) > 0 else None,
            )
            trade = _record_trade(
                user=request.user,
                coin=symbol,
                side=side.capitalize(),
                price=price,
                amount=size,
                total_value=margin_required,
                market_type="futures",
                event_type="futures_open",
            )

        return JsonResponse(
            {
                "status": "ok",
                "trade": TradeSerializer(trade).data,
                "position": PositionSerializer(position).data,
                "new_usdt": float(wallet.balance),
                "locked_margin": float(margin_required),
                "user_id": request.user.id,
                "user_email": request.user.email,
            }
        )
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=400)


def futures_close_all(request):
    if request.method != "POST":
        return JsonResponse({"error": "method_not_allowed"}, status=405)
    if not request.user.is_authenticated:
        return JsonResponse({"error": "unauthorized", "message": "Please log in to close futures positions."}, status=401)

    try:
        import json
        payload = json.loads(request.body.decode("utf-8") or "{}")
        symbol = str(payload.get("symbol", "BTCUSDT")).upper().strip() or "BTCUSDT"
        close_price = Decimal(str(payload.get("close_price", 0)))
        if close_price <= 0:
            return JsonResponse({"error": "invalid_close_price"}, status=400)

        total_released = Decimal("0")
        closed_count = 0
        now = timezone.now()

        with transaction.atomic():
            wallet, _ = Wallet.objects.select_for_update().get_or_create(user=request.user)
            positions = list(Position.objects.select_for_update().filter(
                user=request.user,
                market_type='futures',
                status='open',
                symbol=symbol,
            ))
            for position in positions:
                pnl = (close_price - position.entry_price) * position.amount if position.side == "long" else (position.entry_price - close_price) * position.amount
                released = position.margin + pnl
                total_released += released
                position.status = 'closed'
                position.close_price = close_price
                position.realized_pnl = pnl
                position.closed_at = now
                position.save(update_fields=['status', 'close_price', 'realized_pnl', 'closed_at'])

                _record_trade(
                    user=request.user,
                    coin=symbol,
                    side="Close",
                    price=close_price,
                    amount=position.amount,
                    total_value=released,
                    profit_loss=pnl,
                    market_type="futures",
                    event_type="futures_close",
                )
                closed_count += 1

            wallet.balance += total_released
            wallet.save(update_fields=["balance"])

        return JsonResponse(
            {
                "status": "ok",
                "closed_count": closed_count,
                "released_total": float(total_released),
                "new_usdt": float(wallet.balance),
            }
        )
    except Exception as e:
        return JsonResponse({"error": str(e)}, status=400)
