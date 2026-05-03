/* =====================================================================
 * Splitr — vanilla JS PWA
 * Single-file app logic split into modular sections:
 *   1. Storage      — localStorage-backed state
 *   2. Domain       — group / member / expense / balance helpers
 *   3. Router       — hash-based routing
 *   4. Views        — pure render functions per screen
 *   5. UI utils     — toast, escape, etc.
 *   6. Bootstrap    — service worker + initial render
 * ===================================================================== */

(() => {
  'use strict';

  /* ---------- 1. Storage ---------- */
  const STORAGE_KEY = 'splitr_data';

  const Store = {
    _data: { groups: [] },

    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.groups)) {
            this._data = parsed;
            return;
          }
        }
      } catch (err) {
        console.warn('Splitr: failed to parse storage, resetting.', err);
      }
      this._data = { groups: [] };
    },

    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
      } catch (err) {
        console.error('Splitr: failed to save', err);
        toast('Failed to save data');
      }
    },

    get groups() { return this._data.groups; },

    getGroup(id) {
      return this._data.groups.find(g => g.id === id) || null;
    },

    addGroup(name) {
      const group = {
        id: uid(),
        name: name.trim(),
        members: [],
        expenses: [],
        createdAt: Date.now(),
      };
      this._data.groups.push(group);
      this.save();
      return group;
    },

    deleteGroup(id) {
      this._data.groups = this._data.groups.filter(g => g.id !== id);
      this.save();
    },

    addMember(groupId, name) {
      const g = this.getGroup(groupId);
      if (!g) return null;
      const member = { id: uid(), name: name.trim() };
      g.members.push(member);
      this.save();
      return member;
    },

    deleteMember(groupId, memberId) {
      const g = this.getGroup(groupId);
      if (!g) return;
      // Block deletion if the member is involved in any expense.
      const inUse = g.expenses.some(e => e.paidBy === memberId);
      if (inUse) {
        toast("Can't remove — member has expenses");
        return;
      }
      g.members = g.members.filter(m => m.id !== memberId);
      this.save();
    },

    addExpense(groupId, { description, amount, paidBy }) {
      const g = this.getGroup(groupId);
      if (!g) return null;
      const expense = {
        id: uid(),
        description: description.trim(),
        amount: Number(amount),
        paidBy,
        createdAt: Date.now(),
      };
      g.expenses.push(expense);
      this.save();
      return expense;
    },

    deleteExpense(groupId, expenseId) {
      const g = this.getGroup(groupId);
      if (!g) return;
      g.expenses = g.expenses.filter(e => e.id !== expenseId);
      this.save();
    },
  };

  /* ---------- 2. Domain helpers ---------- */

  // Net balance per member: positive = is owed, negative = owes.
  function computeBalances(group) {
    const balances = Object.create(null);
    group.members.forEach(m => { balances[m.id] = 0; });
    if (group.members.length === 0) return balances;

    for (const exp of group.expenses) {
      const share = exp.amount / group.members.length;
      group.members.forEach(m => {
        balances[m.id] -= share;
      });
      if (balances[exp.paidBy] !== undefined) {
        balances[exp.paidBy] += exp.amount;
      }
    }
    // Round to 2 decimals to avoid floating-point drift.
    for (const id of Object.keys(balances)) {
      balances[id] = Math.round(balances[id] * 100) / 100;
    }
    return balances;
  }

  // Greedy settlement: minimum transfers to clear all debts.
  function settleBalances(balances) {
    const debtors = [];
    const creditors = [];
    for (const [id, val] of Object.entries(balances)) {
      if (val < -0.005) debtors.push({ id, amt: -val });
      else if (val > 0.005) creditors.push({ id, amt: val });
    }
    debtors.sort((a, b) => b.amt - a.amt);
    creditors.sort((a, b) => b.amt - a.amt);

    const transfers = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = Math.min(debtors[i].amt, creditors[j].amt);
      transfers.push({
        from: debtors[i].id,
        to: creditors[j].id,
        amount: Math.round(pay * 100) / 100,
      });
      debtors[i].amt -= pay;
      creditors[j].amt -= pay;
      if (debtors[i].amt < 0.005) i++;
      if (creditors[j].amt < 0.005) j++;
    }
    return transfers;
  }

  function totalSpent(group) {
    return group.expenses.reduce((s, e) => s + e.amount, 0);
  }

  /* ---------- 3. Router ---------- */
  // Routes:
  //   #/                    -> groups list
  //   #/group/:id           -> group detail
  //   #/group/:id/add       -> add expense form

  const Router = {
    parse() {
      const hash = location.hash.replace(/^#/, '') || '/';
      const parts = hash.split('/').filter(Boolean);
      if (parts.length === 0) return { name: 'groups' };
      if (parts[0] === 'group' && parts[1]) {
        if (parts[2] === 'add') return { name: 'addExpense', groupId: parts[1] };
        return { name: 'group', groupId: parts[1] };
      }
      return { name: 'groups' };
    },

    go(path) {
      location.hash = path.startsWith('#') ? path : `#${path}`;
    },

    back() {
      if (history.length > 1) history.back();
      else this.go('/');
    },
  };

  /* ---------- 4. Views ---------- */

  const app = document.getElementById('app');
  const headerTitle = document.getElementById('headerTitle');
  const backBtn = document.getElementById('backBtn');

  backBtn.addEventListener('click', () => Router.back());

  function setHeader(title, { showBack = false } = {}) {
    headerTitle.textContent = title;
    backBtn.hidden = !showBack;
  }

  function render() {
    const route = Router.parse();
    app.innerHTML = '';

    switch (route.name) {
      case 'groups':
        return renderGroups();
      case 'group':
        return renderGroupDetail(route.groupId);
      case 'addExpense':
        return renderAddExpense(route.groupId);
      default:
        return renderGroups();
    }
  }

  /* --- Groups list --- */
  function renderGroups() {
    setHeader('Splitr', { showBack: false });

    const groups = Store.groups
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt);

    const wrap = el('div');

    // Create group card
    wrap.appendChild(el('div', { class: 'section-title' }, 'Create a group'));
    const card = el('div', { class: 'card' });
    const form = el('form', { class: 'form' });
    const nameInput = el('input', {
      type: 'text',
      placeholder: 'e.g. Goa Trip',
      maxlength: '60',
      required: 'true',
      'aria-label': 'Group name',
    });
    const submit = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Create group');
    form.append(
      el('div', { class: 'field' }, nameInput),
      submit,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) { toast('Enter a group name'); return; }
      const g = Store.addGroup(name);
      Router.go(`/group/${g.id}`);
    });
    card.appendChild(form);
    wrap.appendChild(card);

    // Group list
    wrap.appendChild(el('div', { class: 'section-title' }, `Your groups${groups.length ? ` (${groups.length})` : ''}`));

    if (groups.length === 0) {
      wrap.appendChild(emptyState('No groups yet', 'Create one above to get started.', '👥'));
    } else {
      const list = el('div', { class: 'list' });
      for (const g of groups) {
        const total = totalSpent(g);
        const item = el('div', {
          class: 'list-item',
          role: 'button',
          tabindex: '0',
          'data-id': g.id,
        });
        item.append(
          el('div', { class: 'avatar' }, initials(g.name)),
          el('div', { class: 'body' },
            el('div', { class: 'title' }, g.name),
            el('div', { class: 'subtitle' },
              `${g.members.length} member${g.members.length === 1 ? '' : 's'} · ${formatMoney(total)} total`),
          ),
          chevron(),
        );
        item.addEventListener('click', () => Router.go(`/group/${g.id}`));
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            Router.go(`/group/${g.id}`);
          }
        });
        list.appendChild(item);
      }
      wrap.appendChild(list);
    }

    app.appendChild(wrap);
  }

  /* --- Group detail --- */
  function renderGroupDetail(groupId) {
    const group = Store.getGroup(groupId);
    if (!group) {
      setHeader('Not found', { showBack: true });
      app.appendChild(emptyState('Group not found', 'It may have been deleted.', '🤔'));
      return;
    }
    setHeader(group.name, { showBack: true });

    const wrap = el('div');

    // Summary
    const summary = el('div', { class: 'card group-summary' },
      el('span', { class: 'meta' }, 'Total spent'),
      el('span', { class: 'total' }, formatMoney(totalSpent(group))),
      el('span', { class: 'meta' },
        `${group.expenses.length} expense${group.expenses.length === 1 ? '' : 's'} · ${group.members.length} member${group.members.length === 1 ? '' : 's'}`),
    );
    wrap.appendChild(summary);

    // Tabs: Expenses | Members | Balances
    const tabs = el('div', { class: 'tabs', role: 'tablist' });
    const content = el('div');

    const tabDefs = [
      { id: 'expenses', label: 'Expenses', render: () => renderExpensesTab(group) },
      { id: 'members', label: 'Members', render: () => renderMembersTab(group) },
      { id: 'balances', label: 'Balances', render: () => renderBalancesTab(group) },
    ];

    let activeTab = sessionStorage.getItem(`tab:${group.id}`) || 'expenses';
    if (!tabDefs.some(t => t.id === activeTab)) activeTab = 'expenses';

    const renderActive = () => {
      content.innerHTML = '';
      const def = tabDefs.find(t => t.id === activeTab);
      content.appendChild(def.render());
      [...tabs.children].forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === activeTab);
        btn.setAttribute('aria-selected', btn.dataset.tab === activeTab ? 'true' : 'false');
      });
    };

    tabDefs.forEach(def => {
      const btn = el('button', { class: 'tab', role: 'tab', 'data-tab': def.id }, def.label);
      btn.addEventListener('click', () => {
        activeTab = def.id;
        sessionStorage.setItem(`tab:${group.id}`, activeTab);
        renderActive();
      });
      tabs.appendChild(btn);
    });

    wrap.append(tabs, content);
    app.appendChild(wrap);
    renderActive();

    // Floating action button — add expense (only if members exist)
    const fab = el('button', {
      class: 'fab',
      'aria-label': 'Add expense',
      title: 'Add expense',
    }, '+');
    fab.addEventListener('click', () => {
      if (group.members.length === 0) {
        toast('Add at least one member first');
        return;
      }
      Router.go(`/group/${group.id}/add`);
    });
    app.appendChild(fab);

    // Danger zone — delete group
    const danger = el('div', { class: 'spacer-md' });
    wrap.appendChild(danger);
    const deleteBtn = el('button', { class: 'btn btn-danger btn-block' }, 'Delete group');
    deleteBtn.addEventListener('click', () => {
      if (confirm(`Delete "${group.name}"? This cannot be undone.`)) {
        Store.deleteGroup(group.id);
        toast('Group deleted');
        Router.go('/');
      }
    });
    wrap.appendChild(deleteBtn);
  }

  /* --- Group: Expenses tab --- */
  function renderExpensesTab(group) {
    const wrap = el('div');
    if (group.expenses.length === 0) {
      wrap.appendChild(emptyState(
        'No expenses yet',
        group.members.length === 0
          ? 'Add members first, then add an expense.'
          : 'Tap the + button to add one.',
        '🧾',
      ));
      return wrap;
    }

    const list = el('div', { class: 'list' });
    const sorted = group.expenses.slice().sort((a, b) => b.createdAt - a.createdAt);
    for (const e of sorted) {
      const payer = group.members.find(m => m.id === e.paidBy);
      const row = el('div', { class: 'expense' });
      row.append(
        el('div', { class: 'desc' },
          el('div', { class: 'title' }, e.description),
          el('div', { class: 'meta' },
            `Paid by ${payer ? payer.name : 'unknown'} · ${formatDate(e.createdAt)}`),
        ),
        el('div', { class: 'amt' }, formatMoney(e.amount)),
      );
      const del = el('button', { class: 'del', 'aria-label': 'Delete expense', title: 'Delete' });
      del.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';
      del.addEventListener('click', () => {
        if (confirm(`Delete "${e.description}"?`)) {
          Store.deleteExpense(group.id, e.id);
          toast('Expense deleted');
          render();
        }
      });
      row.appendChild(del);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  /* --- Group: Members tab --- */
  function renderMembersTab(group) {
    const wrap = el('div');

    if (group.members.length === 0) {
      wrap.appendChild(emptyState('No members yet', 'Add the first one below.', '👤'));
    } else {
      const chips = el('div', { class: 'chips' });
      for (const m of group.members) {
        const chip = el('div', { class: 'chip' });
        chip.append(
          el('span', { class: 'chip-avatar' }, initials(m.name)),
          el('span', {}, m.name),
        );
        const x = el('button', { class: 'chip-x', 'aria-label': `Remove ${m.name}`, title: 'Remove' }, '×');
        x.addEventListener('click', () => {
          if (confirm(`Remove ${m.name} from this group?`)) {
            Store.deleteMember(group.id, m.id);
            render();
          }
        });
        chip.appendChild(x);
        chips.appendChild(chip);
      }
      wrap.appendChild(chips);
    }

    // Inline add member
    const form = el('form', { class: 'inline-add' });
    const input = el('input', {
      type: 'text',
      placeholder: 'Add member name',
      maxlength: '40',
      'aria-label': 'Member name',
    });
    const addBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Add');
    form.append(input, addBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) { toast('Enter a name'); return; }
      const dup = group.members.some(m => m.name.toLowerCase() === name.toLowerCase());
      if (dup) { toast('Member already exists'); return; }
      Store.addMember(group.id, name);
      input.value = '';
      render();
    });
    wrap.appendChild(form);

    return wrap;
  }

  /* --- Group: Balances tab --- */
  function renderBalancesTab(group) {
    const wrap = el('div');
    if (group.members.length === 0) {
      wrap.appendChild(emptyState('Nothing to settle', 'Add members and expenses first.', '⚖️'));
      return wrap;
    }
    if (group.expenses.length === 0) {
      wrap.appendChild(emptyState('No balances yet', 'Add an expense to see who owes whom.', '💸'));
      return wrap;
    }

    const balances = computeBalances(group);
    const settlements = settleBalances(balances);

    wrap.appendChild(el('div', { class: 'section-title' }, 'Net balances'));
    const list = el('div', { class: 'list' });
    for (const m of group.members) {
      const v = balances[m.id] || 0;
      const cls = v > 0.005 ? 'positive' : (v < -0.005 ? 'negative' : 'zero');
      const label = v > 0.005
        ? `gets back ${formatMoney(v)}`
        : v < -0.005
          ? `owes ${formatMoney(-v)}`
          : 'settled up';
      const row = el('div', { class: `balance-row ${cls}` });
      row.append(
        el('div', { class: 'name' }, m.name),
        el('div', { class: 'amt' }, label),
      );
      list.appendChild(row);
    }
    wrap.appendChild(list);

    wrap.appendChild(el('div', { class: 'section-title' }, 'Who owes whom'));
    if (settlements.length === 0) {
      wrap.appendChild(emptyState('All settled up!', 'No one owes anything.', '🎉'));
    } else {
      const slist = el('div', { class: 'list' });
      for (const t of settlements) {
        const from = group.members.find(m => m.id === t.from);
        const to = group.members.find(m => m.id === t.to);
        const row = el('div', { class: 'settle' });
        row.append(
          el('strong', {}, from ? from.name : '?'),
          el('span', { class: 'arrow' }, '→'),
          el('strong', {}, to ? to.name : '?'),
          el('span', { class: 'amt' }, formatMoney(t.amount)),
        );
        slist.appendChild(row);
      }
      wrap.appendChild(slist);
    }

    return wrap;
  }

  /* --- Add expense form --- */
  function renderAddExpense(groupId) {
    const group = Store.getGroup(groupId);
    if (!group) {
      setHeader('Not found', { showBack: true });
      app.appendChild(emptyState('Group not found', '', '🤔'));
      return;
    }
    if (group.members.length === 0) {
      setHeader('Add expense', { showBack: true });
      app.appendChild(emptyState('No members', 'Add members before creating an expense.', '👤'));
      return;
    }

    setHeader('Add expense', { showBack: true });

    const card = el('div', { class: 'card' });
    const form = el('form', { class: 'form' });

    const descInput = el('input', {
      type: 'text',
      placeholder: 'e.g. Dinner at Olive',
      maxlength: '80',
      required: 'true',
    });
    const amountInput = el('input', {
      type: 'number',
      placeholder: '0.00',
      min: '0.01',
      step: '0.01',
      inputmode: 'decimal',
      required: 'true',
    });
    const paidBySelect = el('select', { required: 'true' });
    paidBySelect.appendChild(el('option', { value: '', disabled: 'true', selected: 'true' }, 'Select payer'));
    for (const m of group.members) {
      paidBySelect.appendChild(el('option', { value: m.id }, m.name));
    }

    const sharePreview = el('div', { class: 'hint' },
      `Splits equally across ${group.members.length} member${group.members.length === 1 ? '' : 's'}.`);

    const updatePreview = () => {
      const amt = Number(amountInput.value);
      if (amt > 0) {
        const share = amt / group.members.length;
        sharePreview.textContent =
          `Each member's share: ${formatMoney(share)} (across ${group.members.length})`;
      } else {
        sharePreview.textContent =
          `Splits equally across ${group.members.length} member${group.members.length === 1 ? '' : 's'}.`;
      }
    };
    amountInput.addEventListener('input', updatePreview);

    form.append(
      el('div', { class: 'field' },
        el('label', {}, 'Description'),
        descInput,
      ),
      el('div', { class: 'field' },
        el('label', {}, 'Amount'),
        amountInput,
        sharePreview,
      ),
      el('div', { class: 'field' },
        el('label', {}, 'Paid by'),
        paidBySelect,
      ),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancel'),
        el('button', { type: 'submit', class: 'btn btn-primary' }, 'Add expense'),
      ),
    );

    form.querySelector('button[type="button"]').addEventListener('click', () => Router.back());

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const description = descInput.value.trim();
      const amount = Number(amountInput.value);
      const paidBy = paidBySelect.value;

      if (!description) { toast('Add a description'); descInput.focus(); return; }
      if (!Number.isFinite(amount) || amount <= 0) { toast('Enter a valid amount'); amountInput.focus(); return; }
      if (!paidBy) { toast('Select who paid'); paidBySelect.focus(); return; }

      Store.addExpense(group.id, { description, amount, paidBy });
      toast('Expense added');
      Router.go(`/group/${group.id}`);
    });

    card.appendChild(form);
    app.appendChild(card);
    descInput.focus();
  }

  /* ---------- 5. UI utils ---------- */

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === true) node.setAttribute(k, '');
        else if (v === false || v == null) continue;
        else if (k === 'class') node.className = v;
        else node.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function emptyState(title, body, emoji = '✨') {
    return el('div', { class: 'empty' },
      el('span', { class: 'emoji' }, emoji),
      el('p', {}, el('strong', {}, title)),
      body ? el('p', {}, body) : null,
    );
  }

  function chevron() {
    const span = document.createElement('span');
    span.className = 'chevron';
    span.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    return span;
  }

  function uid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function initials(name) {
    return (name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(p => p[0] || '')
      .join('')
      .toUpperCase() || '?';
  }

  // Currency: try locale; fall back to symbol-prefixed string.
  const _money = (() => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: detectCurrency(),
        maximumFractionDigits: 2,
      });
    } catch {
      return null;
    }
  })();
  function detectCurrency() {
    try {
      const locale = navigator.language || 'en-US';
      const region = locale.split('-')[1];
      const map = { US: 'USD', GB: 'GBP', IN: 'INR', EU: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', JP: 'JPY', CN: 'CNY', AU: 'AUD', CA: 'CAD' };
      return map[region] || 'USD';
    } catch { return 'USD'; }
  }
  function formatMoney(n) {
    const num = Number(n) || 0;
    if (_money) return _money.format(num);
    return `$${num.toFixed(2)}`;
  }

  function formatDate(ts) {
    try {
      return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch { return ''; }
  }

  let _toastTimer;
  function toast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ---------- 6. Bootstrap ---------- */

  // Fetch the current build's version.json and render it into the footer.
  // Cache-busted + no-store so a fresh deploy is reflected immediately.
  async function loadVersion() {
    const label = document.getElementById('versionLabel');
    if (!label) return;
    try {
      const res = await fetch(`version.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const v = data && typeof data.version === 'string' ? data.version : null;
      if (v) {
        label.textContent = `v${v}`;
        label.title = `Splitr v${v}`;
      }
    } catch {
      // Silent: version is non-critical UI.
      label.textContent = '';
    }
  }

  Store.load();
  loadVersion();
  window.addEventListener('hashchange', render);
  window.addEventListener('storage', (e) => {
    // Sync across tabs.
    if (e.key === STORAGE_KEY) {
      Store.load();
      render();
    }
  });

  render();

  // Service worker registration (only when served over http(s)).
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(err => {
        console.warn('Splitr: SW registration failed', err);
      });
    });
  }
})();
