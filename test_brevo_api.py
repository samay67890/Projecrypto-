from __future__ import print_function
import time
import sib_api_v3_sdk
from sib_api_v3_sdk.rest import ApiException
from pprint import pprint
from decouple import config

# Instantiate the client
configuration = sib_api_v3_sdk.Configuration()
configuration.api_key['api-key'] = config('EMAIL_HOST_PASSWORD', default='')
api_instance = sib_api_v3_sdk.AccountApi(sib_api_v3_sdk.ApiClient(configuration))

try:
    print("Testing Brevo API Key via Account verification...")
    api_response = api_instance.get_account()
    print("SUCCESS! The API key is valid.")
    print(f"Company Name: {api_response.company_name}")
    print(f"Email: {api_response.email}")
except ApiException as e:
    print("Exception when calling AccountApi->get_account: %s\n" % e)
