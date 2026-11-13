'use strict';

const {randomBytes, createHash} = require('node:crypto');

class CardLinks {
  constructor({store, now = () => Date.now()}) {
    this.store = store;
    this.now = now;
  }

  issue(caseId, recipientId) {
    const actor = this.store.person(recipientId);
    const item = this.store.get(caseId, actor);
    const kind = [item.authorId, item.ownerId].includes(recipientId) ? 'participant' : actor.role === 'manager' ? 'supervisor' : null;
    if (!kind) {
      throw Object.assign(new Error('Получатель не участник обращения'), {status: 403});
    }
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    this.store.atomic(() => {
      this.store.suite.cardLinks ||= {};
      this.store.suite.cardLinks[hash] = {caseId, recipientId, kind, expiresAt: this.now() + 7 * 86400000};
    });
    return token;
  }

  resolve(token, actor) {
    const denied = () => { throw Object.assign(new Error('Ссылка недоступна'), {status: 404}); };
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return denied();
    const hash = createHash('sha256').update(token).digest('hex');
    const link = this.store.suite.cardLinks?.[hash];
    if (!link || link.expiresAt <= this.now() || actor?.id !== link.recipientId) return denied();
    try {
      const person = this.store.person(actor.id);
      const item = this.store.get(link.caseId, person);
      if (link.kind === 'supervisor' ? person.role !== 'manager' : ![item.authorId, item.ownerId].includes(person.id)) return denied();
      return link.caseId;
    } catch { return denied(); }
  }
}

module.exports = {CardLinks};
