import { afterEach, describe, expect, it } from 'vitest';
import { signForTest } from './event.test';
import { MAX_EVENTS, RelayPool, validRelayUrl } from './relays';
import { TestRelay } from './test-relay';

const relays: TestRelay[] = [];
const relay = async (opts: ConstructorParameters<typeof TestRelay>[0] = {}) => {
  const r = new TestRelay(opts);
  await r.start();
  relays.push(r);
  return r;
};
afterEach(async () => {
  await Promise.all(relays.splice(0).map((r) => r.stop()));
});
const note = (content = 'olá', tags: string[][] = [['t', 'openspread']]) => signForTest({ kind: 1, created_at: 1_763_000_000, tags, content });
const pool = (urls: string[], timeoutMs = 2000) => new RelayPool(urls, { allowLocal: true, timeoutMs });

describe('validRelayUrl', () => {
  it('só wss; ws só em 127.0.0.1 quando o teste pede', () => {
    expect(validRelayUrl('wss://relay.damus.io')).toBe(true);
    expect(validRelayUrl('ws://relay.damus.io')).toBe(false);
    expect(validRelayUrl('ws://127.0.0.1:7777')).toBe(false);
    expect(validRelayUrl('ws://127.0.0.1:7777', true)).toBe(true);
    expect(validRelayUrl('ws://192.168.0.2:7777', true)).toBe(false);
    expect(validRelayUrl('https://relay.damus.io')).toBe(false);
    expect(validRelayUrl('wss://user:senha@relay.x')).toBe(false);
    expect(validRelayUrl('lixo')).toBe(false);
  });
});

describe('publicar', () => {
  it('publica em vários e diz quais aceitaram', async () => {
    const [a, b] = [await relay(), await relay({ rejectWith: 'blocked: spam' })];
    const e = note();
    const r = await pool([a.url, b.url]).publish(e);
    expect(r).toEqual([{ relay: a.url, accepted: true, message: '' }, { relay: b.url, accepted: false, message: 'blocked: spam' }]);
    expect(a.events.map((x) => x.id)).toEqual([e.id]);
  });
  it('relay fora do ar ou mudo não trava os outros', async () => {
    const ok = await relay();
    const mute = await relay({ silent: true });
    const r = await pool([ok.url, mute.url, 'ws://127.0.0.1:1'], 600).publish(note());
    expect(r.map((x) => x.accepted)).toEqual([true, false, false]);
    expect(r[1].message).toBe('tempo esgotado');
  });
  it('relay com endereço inválido nem é tentado', async () => {
    expect(await pool(['ws://relay.damus.io']).publish(note())).toEqual([]);
  });
});

describe('consultar', () => {
  it('junta os relays sem repetir e ordena pela data', async () => {
    const [a, b] = [await relay(), await relay()];
    const x = signForTest({ kind: 1, created_at: 2, tags: [], content: 'b' });
    const y = signForTest({ kind: 1, created_at: 1, tags: [], content: 'a' });
    a.events.push(x, y);
    b.events.push(x);
    const got = await pool([a.url, b.url]).query({ kinds: [1] });
    expect(got.map((e) => e.content)).toEqual(['a', 'b']);
  });
  it('evento com assinatura falsa ou forma estranha é descartado', async () => {
    const good = note('bom');
    const forged = { ...note('falso'), content: 'trocado depois de assinar' };
    const r = await relay({ inject: [forged, { id: 'x' }, 'lixo'] });
    r.events.push(good);
    expect((await pool([r.url]).query({ kinds: [1] })).map((e) => e.content)).toEqual(['bom']);
  });
  it('mensagem gigante é ignorada', async () => {
    const big = JSON.stringify(['EVENT', 'x', { content: 'a'.repeat(70 * 1024) }]);
    const r = await relay({ raw: [big] });
    r.events.push(note('cabe'));
    expect((await pool([r.url]).query({ kinds: [1] })).map((e) => e.content)).toEqual(['cabe']);
  });
  it('relay mudo devolve vazio no tempo, sem travar', async () => {
    const mute = await relay({ silent: true });
    const t0 = Date.now();
    expect(await pool([mute.url], 400).query({ kinds: [1] })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('limite de eventos', async () => {
    const r = await relay();
    for (let i = 0; i < MAX_EVENTS + 20; i++) r.events.push(signForTest({ kind: 1, created_at: i, tags: [], content: String(i) }));
    expect((await pool([r.url], 8000).query({ kinds: [1] })).length).toBe(MAX_EVENTS);
  }, 30_000);
});
