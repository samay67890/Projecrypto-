
"""
Django settings for nexuscrypto project.

Generated manually to bootstrap the backend so the development server can run.
"""

from pathlib import Path
from datetime import timedelta
import os
import dj_database_url
from decouple import config

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = config('SECRET_KEY', default='django-insecure-change-me')

def _to_bool(value, default=True):
    text = str(value).strip().lower()
    if text in ('1', 'true', 't', 'yes', 'y', 'on'):
        return True
    if text in ('0', 'false', 'f', 'no', 'n', 'off', 'release', 'prod', 'production'):
        return False
    return default

def _read_local_env_value(key: str):
    """Read a key from BASE_DIR/.env so project-local values can override machine env vars."""
    env_path = BASE_DIR / '.env'
    if not env_path.exists():
        return None
    try:
        for raw in env_path.read_text(encoding='utf-8').splitlines():
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            if k.strip() != key:
                continue
            value = v.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            return value
    except Exception:
        return None
    return None

_local_debug = _read_local_env_value('DEBUG')
DEBUG = _to_bool(_local_debug if _local_debug is not None else config('DEBUG', default='True'), default=True)

ALLOWED_HOSTS = [h.strip() for h in config('ALLOWED_HOSTS', default='127.0.0.1,localhost').split(',') if h.strip()]

# Allow Render domain
RENDER_EXTERNAL_HOSTNAME = os.environ.get('RENDER_EXTERNAL_HOSTNAME')
if RENDER_EXTERNAL_HOSTNAME:
    ALLOWED_HOSTS.append(RENDER_EXTERNAL_HOSTNAME)

CSRF_TRUSTED_ORIGINS = config('CSRF_TRUSTED_ORIGINS', default='').split(',')
CSRF_TRUSTED_ORIGINS = [o.strip() for o in CSRF_TRUSTED_ORIGINS if o.strip()]
if RENDER_EXTERNAL_HOSTNAME:
    CSRF_TRUSTED_ORIGINS.append(f'https://{RENDER_EXTERNAL_HOSTNAME}')

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'channels',
    'axes',
    'accounts',
    'core',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'axes.middleware.AxesMiddleware',
]

ROOT_URLCONF = 'nexuscrypto.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'nexuscrypto.wsgi.application'
ASGI_APPLICATION = 'nexuscrypto.asgi.application'

# Database: use DATABASE_URL env var for PostgreSQL on Render, fallback to SQLite locally
DATABASE_URL = config('DATABASE_URL', default='')
if DATABASE_URL:
    DATABASES = {
        'default': dj_database_url.parse(DATABASE_URL)
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': config('DATABASE_ENGINE', default='django.db.backends.sqlite3'),
            'NAME': BASE_DIR / config('DATABASE_NAME', default='db.sqlite3'),
        }
    }

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True

STATIC_URL = '/static/'
STATICFILES_DIRS = [BASE_DIR / 'static'] if (BASE_DIR / 'static').exists() else []
STATIC_ROOT = BASE_DIR / 'staticfiles'

# Use non-strict storage to prevent 500 errors when static files aren't in manifest
STATICFILES_STORAGE = 'whitenoise.storage.CompressedStaticFilesStorage'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# Authentication backends — axes backend MUST come first
AUTHENTICATION_BACKENDS = [
    'axes.backends.AxesStandaloneBackend',
    'django.contrib.auth.backends.ModelBackend',
]

# django-axes: brute-force login protection
AXES_FAILURE_LIMIT = 5                                  # lock after 5 wrong attempts
AXES_COOLOFF_TIME = timedelta(minutes=30)               # unlock after 30 minutes
AXES_LOCKOUT_PARAMETERS = [["username", "ip_address"]]  # per user+IP combination
AXES_RESET_ON_SUCCESS = True                            # reset counter on successful login
AXES_LOCKOUT_TEMPLATE = None                            # we handle in view
AXES_ENABLED = True

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels.layers.InMemoryChannelLayer",
    }
}

AUTH_USER_MODEL = 'accounts.User'

# Email Configuration
EMAIL_BACKEND = config('EMAIL_BACKEND', default='django.core.mail.backends.smtp.EmailBackend')
EMAIL_HOST = config('EMAIL_HOST', default='smtp-relay.brevo.com')
EMAIL_PORT = config('EMAIL_PORT', default=2525, cast=int)
EMAIL_USE_TLS = config('EMAIL_USE_TLS', default=True, cast=bool)
EMAIL_USE_SSL = config('EMAIL_USE_SSL', default=False, cast=bool)
EMAIL_TIMEOUT = config('EMAIL_TIMEOUT', default=10, cast=int)
EMAIL_HOST_USER = config('EMAIL_HOST_USER', default='')
EMAIL_HOST_PASSWORD = config('EMAIL_HOST_PASSWORD', default='')
DEFAULT_FROM_EMAIL = config('DEFAULT_FROM_EMAIL', default='noreply@nexuscrypto.com')

# Prevent Django crash if both TLS and SSL are accidentally True in environment variables
if EMAIL_USE_SSL:
    EMAIL_USE_TLS = False

# Market data keys
COINAPI_API_KEY = config('COINAPI_API_KEY', default='')
BINANCE_API_KEY = config('BINANCE_API_KEY', default='')

# Logging — ensures errors are visible in Render's log viewer
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '[{levelname}] {asctime} {name}: {message}',
            'style': '{',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'formatter': 'verbose',
        },
    },
    'root': {
        'handlers': ['console'],
        'level': 'INFO',
    },
    'loggers': {
        'django': {
            'handlers': ['console'],
            'level': 'INFO',
            'propagate': False,
        },
        'core': {
            'handlers': ['console'],
            'level': 'DEBUG',
            'propagate': False,
        },
    },
}
