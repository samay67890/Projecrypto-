document.addEventListener("DOMContentLoaded", function () {
  const form = document.getElementById("signin-form");
  if (!form) return;

  form.addEventListener("submit", function (event) {
    const emailInput = form.querySelector('input[name="email"]');
    const passwordInput = form.querySelector('input[name="password"]');

    const email = emailInput ? emailInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value : "";

    if (!email || !password) {
      event.preventDefault();
      alert("Please enter both email and password.");
      if (!email && emailInput) {
        emailInput.focus();
      } else if (passwordInput) {
        passwordInput.focus();
      }
      return;
    }

    const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!isEmailValid) {
      event.preventDefault();
      alert("Please enter a valid email address.");
      if (emailInput) emailInput.focus();
    }
  });
});
