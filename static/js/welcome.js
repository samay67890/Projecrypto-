(function () {
    var container = document.querySelector('.reveal-container');
    if (!container) return;

    // Ensure the page stays centered and non-scrollable while this view is shown
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    // Optional: small hover effect on the arrow link text
    var link = container.querySelector('.arrow-link');
    if (link) {
        link.addEventListener('mouseenter', function () {
            link.style.opacity = '0.9';
        });
        link.addEventListener('mouseleave', function () {
            link.style.opacity = '1';
        });
    }
})();

