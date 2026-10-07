// A link that opens Gmail's compose window with an email already filled
// in, in the person's own browser and Google account. Nothing is sent
// until they press Send there — which is the point: the email leaves
// from their own Gmail, with no mail server set up anywhere.
//
// `authuser` picks the right account when someone is signed in to more
// than one (their work account rather than a personal one).
export function gmailCompose({ to, cc, subject, body, account }) {
  const q = new URLSearchParams({ view: 'cm', fs: '1', to: to || '', su: subject || '', body: body || '' });
  if (cc) q.set('cc', cc);
  if (account) q.set('authuser', account);
  return `https://mail.google.com/mail/?${q.toString()}`;
}
