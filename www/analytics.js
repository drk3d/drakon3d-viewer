// Analytics is intentionally limited to the public hosted Viewer. Exported
// packages and local/offline copies must remain self-contained and untracked.
const MEASUREMENT_ID = 'G-R7M5N2PPR1';
const isHostedViewer = window.location.hostname === 'viewer.drakon3d.com'
  && !window.__RHV_PACKAGE__
  && !window.__RHV_PACKAGE_ENCRYPTED__;

if (isHostedViewer) {
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() {
    window.dataLayer.push(arguments);
  };

  window.gtag('js', new Date());
  window.gtag('config', MEASUREMENT_ID);

  const tag = document.createElement('script');
  tag.async = true;
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
  document.head.appendChild(tag);
}
