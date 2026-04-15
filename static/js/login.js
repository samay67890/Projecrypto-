// NexusCrypto signup (email step) - client-side validation + Google Sign-In
document.addEventListener('DOMContentLoaded', function () {
  // ─── Email form validation ───
  const form = document.querySelector('.form-card form');
  if (form) {
    function isValidEmail(val) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
    }

    form.addEventListener('submit', function (e) {
      const emailInput = form.querySelector('input[name="email"]');
      const termsInput = form.querySelector('input[name="terms"]');
      const email = emailInput ? emailInput.value.trim() : '';
      const termsChecked = termsInput ? termsInput.checked : false;

      if (!email) {
        e.preventDefault();
        alert('Please enter your email.');
        if (emailInput) emailInput.focus();
        return;
      }
      if (!isValidEmail(email)) {
        e.preventDefault();
        alert('Please enter a valid email address.');
        if (emailInput) emailInput.focus();
        return;
      }
      if (!termsChecked) {
        e.preventDefault();
        alert("You must agree to NexusCrypto's Terms and Privacy Policy.");
        if (termsInput) termsInput.focus();
        return;
      }
      // Validation passed - allow default form submit (POST to server, then redirect)
    });
  }


});
