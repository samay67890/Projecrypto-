
"""
Django settings for nexuscrypto project.

Generated manually to bootstrap the backend so the development server can run.
"""

from pathlib import Path
from datetime import timedelta
import os
import dj_database_url
from decouple import config
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / '.env')

SECRET_KEY = config('SECRET_KEY', default='django-insecure-change-me')

def _to_bool(value, default=True):
    text = str(value).strip().lower()
    if text in ('1', 'true', 't', 'yes', 'y', 'on'):
        return True
    if text in ('0', 'false', 'f', 'no', 'n', 'off', 'release', 'prod', 'production'):
        return False
    return default

DEBUG = _to_bool(config('DEBUG', default='False'), default=False)

ALLOWED_HOSTS = [h.strip() for h in config('ALLOWED_HOSTS', default='127.0.0.1,localhost').split(',') if h.strip()]
DEFAULT_RENDER_HOST = 'projecrypto.onrender.com'
if DEFAULT_RENDER_HOST not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append(DEFAULT_RENDER_HOST)

# Allow Render domain
RENDER_EXTERNAL_HOSTNAME = os.environ.get('RENDER_EXTERNAL_HOSTNAME')
if RENDER_EXTERNAL_HOSTNAME:
    ALLOWED_HOSTS.append(RENDER_EXTERNAL_HOSTNAME)

CSRF_TRUSTED_ORIGINS = config('CSRF_TRUSTED_ORIGINS', default='').split(',')
CSRF_TRUSTED_ORIGINS = [o.strip() for o in CSRF_TRUSTED_ORIGINS if o.strip()]
default_render_origin = f'https://{DEFAULT_RENDER_HOST}'
if default_render_origin not in CSRF_TRUSTED_ORIGINS:
    CSRF_TRUSTED_ORIGINS.append(default_render_origin)
if RENDER_EXTERNAL_HOSTNAME:
    CSRF_TRUSTED_ORIGINS.append(f'https://{RENDER_EXTERNAL_HOSTNAME}')

INSTALLED_APPS = [
    'unfold',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'channels',
    'axes',
    'accounts.apps.AccountsConfig',
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

# Database: use DATABASE_URL for both local and Render.
# Example: postgresql://USER:PASSWORD@HOST:5432/DBNAME
DATABASE_URL = config('DATABASE_URL', default='').strip()
if DATABASE_URL:
    db_config = {
        'conn_max_age': 600,
    }
    if DATABASE_URL.startswith(('postgres://', 'postgresql://')):
        db_config['ssl_require'] = not DEBUG

    DATABASES = {
        'default': dj_database_url.parse(
            DATABASE_URL,
            **db_config,
        )
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'db.sqlite3',
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

# Use safer storage in production so stale/missing static references are caught at build time.
STATICFILES_STORAGE = (
    'whitenoise.storage.CompressedManifestStaticFilesStorage'
    if not DEBUG
    else 'whitenoise.storage.CompressedStaticFilesStorage'
)

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# Authentication backends — axes backend MUST come first
AUTHENTICATION_BACKENDS = [
    'axes.backends.AxesStandaloneBackend',
    'django.contrib.auth.backends.ModelBackend',
]

# django-axes: brute-force login protection tuned for fewer false lockouts.
AXES_FAILURE_LIMIT = config('AXES_FAILURE_LIMIT', default=8, cast=int)
AXES_COOLOFF_TIME = timedelta(minutes=config('AXES_COOLOFF_MINUTES', default=15, cast=int))
AXES_LOCKOUT_PARAMETERS = [["username"]]
AXES_RESET_ON_SUCCESS = True
AXES_LOCKOUT_TEMPLATE = None
AXES_ENABLED = _to_bool(config('AXES_ENABLED', default='True'), default=True)

if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_SSL_REDIRECT = _to_bool(config('SECURE_SSL_REDIRECT', default='True'), default=True)
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True

# Redis (Render Key Value / Redis-compatible)
# Use REDIS_URL on Render, e.g. rediss://default:password@host:6379
REDIS_URL = config('REDIS_URL', default='').strip()

if REDIS_URL:
    CACHES = {
        "default": {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": REDIS_URL,
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
            },
            "TIMEOUT": 300,
        }
    }
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {
                "hosts": [REDIS_URL],
            },
        }
    }
else:
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "nexuscrypto-local-cache",
            "TIMEOUT": 300,
        }
    }
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

# Auth0 OAuth 2.0
AUTH0_DOMAIN = config('AUTH0_DOMAIN', default='')
AUTH0_CLIENT_ID = config('AUTH0_CLIENT_ID', default='')
AUTH0_CLIENT_SECRET = config('AUTH0_CLIENT_SECRET', default='')

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

# Media Files (For KYC Uploads)
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

# Trigger auto-reload for .env update
# Auth0 Reload Trigger
