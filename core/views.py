import random
from datetime import timedelta

from django.contrib.auth import authenticate, get_user_model, login as auth_login, logout as auth_logout
from django.contrib.auth.hashers import check_password, make_password
from django.contrib.auth.password_validation import validate_password
from django.conf import settings
from django.http import HttpResponse, HttpResponseBadRequest, JsonResponse
import requests
from django.shortcuts import redirect, render
from django.utils import timezone
from django.views import View

from accounts.models import OTP
from core.email_service import send_otp_email

User = get_user_model()

# region agent log
import json as _json
import time as _time

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
        # Never break request flow due to logging
        pass

# endregion agent log


def _create_otp_for_email(email):
    """Generate a 6-digit OTP for email, store hashed version, return plain code for sending."""
    try:
        # region agent log
        _dbg_log(
            runId="pre-fix",
            hypothesisId="H2",
            location="core/views.py:_create_otp_for_email:start",
            message="Creating OTP for email",
            data={
                "email_present": bool(email),
                "email_len": len(email) if isinstance(email, str) else None,
                "email_has_at": ("@" in email) if isinstance(email, str) else None,
            },
        )
        # endregion agent log

        code = ''.join(str(random.randint(0, 9)) for _ in range(6))
        otp_hash = make_password(code)
        expires_at = timezone.now() + timedelta(minutes=10)  # 10 minutes expiry
        
        # Create OTP record
        otp = OTP.objects.create(
            email=email,
            otp_hash=otp_hash,
            expires_at=expires_at,
            user=None  # Explicitly set to None since user doesn't exist yet
        )

        # region agent log
        _dbg_log(
            runId="pre-fix",
            hypothesisId="H2",
            location="core/views.py:_create_otp_for_email:created",
            message="OTP DB row created",
            data={"otp_id": otp.id},
        )
        # endregion agent log
        
        return code
    except Exception as e:
        # region agent log
        _dbg_log(
            runId="pre-fix",
            hypothesisId="H2",
            location="core/views.py:_create_otp_for_email:exception",
            message="Exception creating OTP",
            data={"err_type": e.__class__.__name__},
        )
        # endregion agent log
        raise  # Re-raise to be caught by calling function


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
        email = request.session.get('signup_email')
        if not email:
            # region agent log
            _dbg_log(
                runId="pre-fix",
                hypothesisId="H1",
                location="core/views.py:SignupPasswordView.post:no_email",
                message="No signup_email in session; redirecting to login",
                data={"session_keys": list(request.session.keys())[:20], "session_key_count": len(request.session.keys())},
            )
            # endregion agent log
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

        # Store password in session temporarily (Django sessions are encrypted)
        # We need plain password to create user after OTP verification
        request.session['signup_email'] = email  # Ensure email is still in session
        request.session['signup_password_plain'] = password1

        # region agent log
        _dbg_log(
            runId="pre-fix",
            hypothesisId="H1",
            location="core/views.py:SignupPasswordView.post:session_set",
            message="Stored signup_email and signup_password_plain in session",
            data={
                "email_len": len(email) if isinstance(email, str) else None,
                "password_len": len(password1) if isinstance(password1, str) else None,
                "session_key_count": len(request.session.keys()),
            },
        )
        # endregion agent log
        
        # Generate OTP for email and send email
        try:
            code = _create_otp_for_email(email)

            # Send OTP email (don't fail if email sending fails)
            email_sent = send_otp_email(email, code)

            if settings.DEBUG:
                request.session['debug_otp'] = code

            # region agent log
            _dbg_log(
                runId="pre-fix",
                hypothesisId="H4",
                location="core/views.py:SignupPasswordView.post:email_sent",
                message="send_otp_email returned",
                data={"email_sent": bool(email_sent)},
            )
            # endregion agent log
        except Exception as e:
            # region agent log
            _dbg_log(
                runId="pre-fix",
                hypothesisId="H3",
                location="core/views.py:SignupPasswordView.post:exception",
                message="Exception during OTP create/send",
                data={"err_type": e.__class__.__name__},
            )
            # endregion agent log
            
            # Show user-friendly error message
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
            # region agent log
            _dbg_log(
                runId="pre-fix",
                hypothesisId="H1",
                location="core/views.py:SignupPasswordView.post:session_saved",
                message="request.session.save() succeeded",
                data={"session_key_count": len(request.session.keys())},
            )
            # endregion agent log
        except Exception as e:
            # region agent log
            _dbg_log(
                runId="pre-fix",
                hypothesisId="H1",
                location="core/views.py:SignupPasswordView.post:session_save_exception",
                message="request.session.save() raised",
                data={"err_type": e.__class__.__name__},
            )
            # endregion agent log
            # Let redirect still happen; OTP page will show what session exists
        
        return redirect('signup_verify_otp')


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
        return redirect('dashboard')


class SignupVerifyOtpView(View):
    """Step 3: verify OTP, THEN create user account, link OTP to user, login and redirect to welcome screen."""

    def get(self, request):
        email = request.session.get('signup_email')
        plain_password = request.session.get('signup_password_plain')

        # region agent log
        _dbg_log(
            runId="pre-fix",
            hypothesisId="H1",
            location="core/views.py:SignupVerifyOtpView.get:entry",
            message="OTP page GET",
            data={
                "has_email": bool(email),
                "has_password": bool(plain_password),
                "session_key_count": len(request.session.keys()),
                "session_keys": list(request.session.keys())[:20],
            },
        )
        # endregion agent log
        
        if not email or not plain_password:
            # region agent log
            _dbg_log(
                runId="pre-fix",
                hypothesisId="H1",
                location="core/views.py:SignupVerifyOtpView.get:redirect_login",
                message="Missing session data; redirecting to login",
                data={"has_email": bool(email), "has_password": bool(plain_password)},
            )
            # endregion agent log
            return redirect('signup')
        
        # Check if user already exists (shouldn't happen, but safety check)
        if User.objects.filter(email=email).exists():
            request.session.flush()
            return redirect('login')
        
        context = {'email': email}
        if settings.DEBUG:
            context['debug_otp'] = request.session.get('debug_otp')

        # region agent log
        _dbg_log(
            runId="pre-fix",
            hypothesisId="H3",
            location="core/views.py:SignupVerifyOtpView.get:render",
            message="Rendering OTP template",
            data={"debug_otp_present": bool(request.session.get("debug_otp"))},
        )
        # endregion agent log
        
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

        # Verify OTP using email (not user, since user doesn't exist yet)
        now = timezone.now()
        otp_record = (
            OTP.objects.filter(email=email, is_used=False, expires_at__gt=now, user__isnull=True)
            .order_by('-created_at')
            .first()
        )
        
        if not otp_record or not check_password(otp_value, otp_record.otp_hash):
            return render(request, 'core/signup/verify_otp.html', {
                'email': email,
                'error': 'Invalid or expired code. Please try again or resend.',
            })

        # OTP verified! Now create the user account
        # Create user account
        user = User.objects.create_user(
            email=email,
            password=plain_password,
            username=email,
        )
        
        # Link OTP to user
        otp_record.user = user
        otp_record.is_used = True
        otp_record.save(update_fields=['user', 'is_used'])
        
        # Clear signup info and mark that we should show the welcome screen once.
        for key in ('signup_email', 'signup_password_plain', 'debug_otp'):
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
        
        # Send OTP email
        send_otp_email(email, code)
        
        if settings.DEBUG:
            request.session['debug_otp'] = code
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


def order(request):
    if request.method != "POST":
        return JsonResponse({"error": "method_not_allowed"}, status=405)
    try:
        payload = _jsonlib.loads(request.body.decode("utf-8") or "{}")
        side = payload.get("side")
        price = payload.get("price")
        size = payload.get("size")
        return JsonResponse({"status": "ok", "side": side, "price": price, "size": size})
    except Exception:
        return JsonResponse({"error": "bad_request"}, status=400)
