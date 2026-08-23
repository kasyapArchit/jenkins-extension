// Drives the harness into a particular state from the URL, so the README's
// screenshots can be retaken by running a command rather than by clicking
// around and hoping to reproduce the same view.
//
//   ?q=deploy   type a search query
//   ?open=1     expand the parameter panel of the nth starred card
//   ?subs       open the subscribed list in the footer
//
// Only loaded by dev/preview.html, and only does anything when asked.

const params = new URLSearchParams(location.search);
const q = params.get('q');
const open = params.get('open');
const subs = params.has('subs');
// Always run, even with none of the above, so a plain browse view still ends
// in the same shotReady signal a screenshot tool can wait on.
apply();

async function apply() {
  // The popup renders from storage on load, so wait for it rather than racing.
  await until(() => document.querySelector('#starred .card') || document.querySelector('#results .result'));

  if (q) {
    const input = document.querySelector('#q');
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => document.querySelector('#results .result'));
  }

  if (open !== null) {
    const scope = q ? '#results .result' : '#starred .card .card-main';
    const cards = document.querySelectorAll(scope);
    cards[Number(open) || 0]?.click();
    await until(() => document.querySelector('.panel-wrap.open'));
    await pause(250);   // let the expand animation finish
    // The popup is a fixed 600px and the activity list is above the cards, so a
    // freshly opened panel is usually below the fold.
    document.querySelector('.panel-wrap.open')?.scrollIntoView({ block: 'center' });
    await pause(100);
  }

  if (subs) {
    document.querySelector('.count-btn')?.click();
    await until(() => document.querySelector('.subs-row'));
  }

  document.documentElement.dataset.shotReady = '1';
}

const pause = ms => new Promise(r => setTimeout(r, ms));

async function until(test, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (test()) return true;
    await pause(50);
  }
  return false;
}
