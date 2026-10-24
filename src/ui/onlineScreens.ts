import { NAME_MAX_LENGTH, ROOM_CODE_LENGTH, type LobbyView } from '../net/protocol';
import { h, ICONS, svg } from './dom';

function brand(): HTMLElement {
  const wrap = h('div', { class: 'brand brand--small' });
  wrap.append(svg(ICONS.logo), h('span', { class: 'wordmark', text: 'cardify' }));
  return wrap;
}

export interface EntryOptions {
  name: string;
  code: string;
  /** Saved table the player can rejoin, if any. */
  rejoinCode: string | null;
  /** Shown when online play is unavailable for this deployment. */
  unavailable: string | null;
  busy: string | null;
  error: string | null;
  onCreate(name: string): void;
  onJoin(code: string, name: string): void;
  onRejoin(): void;
  onBack(): void;
}

/** "Play with Friends": pick a name, then create a table or join one by code. */
export function entryScreen(o: EntryOptions): HTMLElement {
  const nameInput = h('input', {
    class: 'field__input',
    attrs: {
      id: 'online-name',
      type: 'text',
      maxlength: NAME_MAX_LENGTH,
      autocomplete: 'nickname',
      autocapitalize: 'words',
      spellcheck: 'false',
      placeholder: 'How friends will see you',
      enterkeyhint: 'go',
    },
  });
  nameInput.value = o.name;
  const codeInput = h('input', {
    class: 'field__input field__input--code',
    attrs: {
      id: 'online-code',
      type: 'text',
      maxlength: ROOM_CODE_LENGTH,
      autocomplete: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      placeholder: 'K7QPM',
      inputmode: 'text',
      enterkeyhint: 'join',
      'aria-describedby': 'online-code-hint',
    },
  });
  codeInput.value = o.code;
  codeInput.addEventListener('input', () => {
    const cleaned = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
    if (cleaned !== codeInput.value) codeInput.value = cleaned;
  });

  const disabled = !!o.unavailable || !!o.busy;
  const errorLine = h('p', { class: 'form-error', attrs: { role: 'alert' }, text: o.error ?? '' });
  const validName = (): string | null => {
    const name = nameInput.value.trim();
    if (!name) {
      errorLine.textContent = 'Enter a name first.';
      nameInput.focus();
      return null;
    }
    return name;
  };

  const create = h('button', {
    class: 'btn btn--primary btn--wide',
    text: 'Create a table',
    attrs: { type: 'button', disabled },
    on: {
      click: () => {
        const name = validName();
        if (name) o.onCreate(name);
      },
    },
  });
  const join = h('button', {
    class: 'btn btn--secondary',
    text: 'Join',
    attrs: { type: 'submit', disabled },
  });
  const joinForm = h(
    'form',
    {
      class: 'join',
      on: {
        submit: (e) => {
          e.preventDefault();
          const name = validName();
          if (!name) return;
          const code = codeInput.value.trim().toUpperCase();
          if (code.length !== ROOM_CODE_LENGTH) {
            errorLine.textContent = `Table codes have ${ROOM_CODE_LENGTH} characters.`;
            codeInput.focus();
            return;
          }
          o.onJoin(code, name);
        },
      },
    },
    h('label', { class: 'field__label', text: 'Table code', attrs: { for: 'online-code' } }),
    h('div', { class: 'join__row' }, codeInput, join),
    h('span', { class: 'field__hint', attrs: { id: 'online-code-hint' }, text: 'Ask the host for the 5-character code.' }),
  );

  return h(
    'main',
    { class: 'screen screen--online' },
    h(
      'div',
      { class: 'online' },
      brand(),
      h('h1', { class: 'online__title', text: 'Play with friends' }),
      h('p', { class: 'online__lead', text: 'Private tables for 2–6 players. The host can fill empty seats with Nova, Vex or Orion.' }),
      o.unavailable ? h('p', { class: 'notice', text: o.unavailable }) : null,
      o.busy ? h('p', { class: 'online__busy', attrs: { role: 'status' }, text: o.busy }) : null,
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label', text: 'Your name', attrs: { for: 'online-name' } }),
        nameInput,
      ),
      o.rejoinCode
        ? h('button', {
            class: 'btn btn--primary btn--wide',
            text: `Rejoin table ${o.rejoinCode}`,
            attrs: { type: 'button', disabled },
            on: { click: o.onRejoin },
          })
        : null,
      create,
      h('div', { class: 'divider', attrs: { role: 'separator' } }, h('span', { text: 'or join a friend' })),
      joinForm,
      errorLine,
      h('button', { class: 'link-btn', text: 'Back', attrs: { type: 'button' }, on: { click: o.onBack } }),
    ),
  );
}

export interface LobbyOptions {
  lobby: LobbyView;
  inviteUrl: string;
  connection: string | null;
  onCopy(text: string, button: HTMLButtonElement): void;
  onAddBot(): void;
  onRemove(playerId: string): void;
  onStart(): void;
  onLeave(): void;
}

/** Waiting room: share the code, see who is seated, host starts the game. */
export function lobbyScreen(o: LobbyOptions): HTMLElement {
  const { lobby } = o;
  const isHost = lobby.you === lobby.hostId;
  const host = lobby.seats.find((s) => s.id === lobby.hostId);
  const full = lobby.seats.length >= lobby.maxSeats;

  const seats = h('ol', { class: 'seats', attrs: { 'aria-label': `Seats, ${lobby.seats.length} of ${lobby.maxSeats} taken` } });
  for (let i = 0; i < lobby.maxSeats; i++) {
    const seat = lobby.seats[i];
    if (!seat) {
      seats.append(h('li', { class: 'seats__row is-open' }, h('span', { class: 'seats__avatar', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'seats__name', text: 'Open seat' })));
      continue;
    }
    const badges = h('span', { class: 'seats__badges' });
    if (seat.id === lobby.you) badges.append(h('span', { class: 'badge badge--you', text: 'You' }));
    if (seat.id === lobby.hostId) badges.append(h('span', { class: 'badge', text: 'Host' }));
    if (seat.kind === 'bot') badges.append(h('span', { class: 'badge', text: 'Bot' }));
    if (seat.kind === 'human' && !seat.connected) badges.append(h('span', { class: 'badge badge--muted', text: 'Offline' }));
    const remove =
      isHost && seat.id !== lobby.you
        ? h('button', {
            class: 'seats__remove',
            attrs: { type: 'button', 'aria-label': `Remove ${seat.name}` },
            on: { click: () => o.onRemove(seat.id) },
          })
        : null;
    remove?.append(svg(ICONS.close));
    seats.append(
      h(
        'li',
        { class: `seats__row${seat.kind === 'human' && !seat.connected ? ' is-offline' : ''}`, dataset: { profile: seat.botProfile ?? 'human' } },
        h('span', { class: 'seats__avatar', text: seat.name.charAt(0), attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'seats__name', text: seat.name }),
        badges,
        remove,
      ),
    );
  }

  const copyCode = h('button', {
    class: 'code',
    attrs: { type: 'button', 'aria-label': `Table code ${lobby.code.split('').join(' ')}. Tap to copy.` },
    on: { click: () => o.onCopy(lobby.code, copyCode) },
  });
  copyCode.append(h('span', { class: 'code__value', text: lobby.code }), h('span', { class: 'code__hint', text: 'Tap to copy' }));
  const copyLink = h('button', {
    class: 'btn btn--secondary btn--wide',
    text: 'Copy invite link',
    attrs: { type: 'button' },
    on: { click: () => o.onCopy(o.inviteUrl, copyLink) },
  });

  const actions = h('div', { class: 'lobby__actions' });
  if (isHost) {
    actions.append(
      h('button', {
        class: 'btn btn--primary btn--wide',
        text: lobby.canStart ? `Start game · ${lobby.seats.length} players` : 'Start game',
        attrs: { type: 'button', disabled: !lobby.canStart },
        on: { click: o.onStart },
      }),
      h('button', {
        class: 'btn btn--secondary btn--wide',
        text: full ? 'Table is full' : 'Add a bot',
        attrs: { type: 'button', disabled: full },
        on: { click: o.onAddBot },
      }),
    );
    if (!lobby.canStart) actions.append(h('p', { class: 'field__hint', text: 'You need at least one more player or a bot.' }));
  } else {
    actions.append(h('p', { class: 'lobby__waiting', text: `Waiting for ${host?.name ?? 'the host'} to start the game…` }));
  }

  return h(
    'main',
    { class: 'screen screen--lobby' },
    h(
      'div',
      { class: 'lobby' },
      brand(),
      h('p', { class: 'eyebrow', text: 'Private table' }),
      copyCode,
      h('p', { class: 'online__lead', text: 'Friends open cardify, tap Play with Friends and enter this code — or just send them the link.' }),
      copyLink,
      o.connection ? h('p', { class: 'online__busy', attrs: { role: 'status' }, text: o.connection }) : null,
      seats,
      actions,
      h('button', { class: 'link-btn', text: 'Leave table', attrs: { type: 'button' }, on: { click: o.onLeave } }),
    ),
  );
}
