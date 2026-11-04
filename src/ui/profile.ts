import { NAME_MAX_LENGTH } from '../net/protocol';
import { loadProfile, resetStats, setProfileName, type Profile } from '../storage/profile';
import { h } from './dom';
import { ordinal } from './format';

/** The "Profile" sheet: a display name and lifetime stats, all kept on this device. */
export function profileBody(): HTMLElement {
  let profile: Profile = loadProfile();
  const stat = (label: string, value: string) => h('div', { class: 'stats__item' }, h('dt', { text: label }), h('dd', { text: value }));
  const holdem = h('dl', { class: 'stats' });
  const durak = h('dl', { class: 'stats' });
  const fill = (): void => {
    const p = profile;
    holdem.replaceChildren(
      stat('Sit & Gos', String(p.holdem.tournaments)),
      stat('Won', String(p.holdem.won)),
      stat('Best finish', p.holdem.bestPlace ? ordinal(p.holdem.bestPlace) : '—'),
    );
    durak.replaceChildren(stat('Games', String(p.durak.games)), stat('Got out', String(p.durak.safe + p.durak.draws)), stat('Durak', String(p.durak.durak)));
  };
  fill();

  const input = h('input', {
    class: 'field__input',
    attrs: { id: 'profile-name', type: 'text', maxlength: NAME_MAX_LENGTH, autocomplete: 'nickname', placeholder: 'How friends will see you', enterkeyhint: 'done' },
  });
  input.value = profile.name;
  input.addEventListener('change', () => {
    profile = setProfileName(input.value);
    input.value = profile.name;
  });

  let armed = false;
  const reset = h('button', {
    class: 'menu__item menu__item--danger',
    text: 'Reset statistics',
    attrs: { type: 'button' },
    on: {
      click: () => {
        if (!armed) {
          armed = true;
          reset.textContent = 'Tap again to reset';
          return;
        }
        profile = resetStats();
        armed = false;
        reset.textContent = 'Reset statistics';
        fill();
      },
    },
  });

  return h(
    'div',
    { class: 'settings profile' },
    h('div', { class: 'field' }, h('label', { class: 'field__label', text: 'Your name', attrs: { for: 'profile-name' } }), input, h('span', { class: 'field__hint', text: 'Used when you open or join a private table.' })),
    h('h3', { class: 'setting__label', text: "Texas Hold'em (solo)" }),
    holdem,
    h('h3', { class: 'setting__label', text: 'Durak (solo)' }),
    durak,
    h('p', { class: 'field__hint', text: 'Statistics live on this device only. Every finished game counts once.' }),
    reset,
  );
}
