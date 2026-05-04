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
  const CURRENCY_KEY = 'splitr_currency';

  // Display-only currency list. No conversion is ever performed —
  // changing this only swaps the symbol shown in the UI.
  const CURRENCIES = [
    { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
    { code: 'USD', symbol: '$', name: 'US Dollar' },
    { code: 'EUR', symbol: '€', name: 'Euro' },
    { code: 'GBP', symbol: '£', name: 'British Pound' },
  ];
  const DEFAULT_CURRENCY = 'INR';

  function getCurrency() {
    let code;
    try { code = localStorage.getItem(CURRENCY_KEY); } catch { code = null; }
    return CURRENCIES.find(c => c.code === code)
        || CURRENCIES.find(c => c.code === DEFAULT_CURRENCY);
  }

  function setCurrency(code) {
    if (!CURRENCIES.some(c => c.code === code)) return;
    try { localStorage.setItem(CURRENCY_KEY, code); } catch { /* ignore */ }
  }

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

    updateGroup(id, name) {
      const g = this.getGroup(id);
      if (!g) return false;
      const trimmed = (name || '').trim();
      if (!trimmed) return false;
      g.name = trimmed;
      this.save();
      return true;
    },

    deleteGroup(id) {
      this._data.groups = this._data.groups.filter(g => g.id !== id);
      this.save();
    },

    // Insert a sanitised group (or replace an existing one with the same id).
    // Used by the import flow when the user opts to overwrite their copy.
    replaceGroup(group) {
      const clean = sanitizeImportedGroup(group);
      if (!clean) return null;
      const idx = this._data.groups.findIndex(g => g.id === clean.id);
      if (idx >= 0) this._data.groups[idx] = clean;
      else this._data.groups.push(clean);
      this.save();
      return clean;
    },

    // Import a sanitised group as a brand-new copy: regenerates the
    // group id and member ids (remapping `paidBy` references), so it
    // never collides with the existing local copy.
    addGroupAsCopy(group) {
      const clean = sanitizeImportedGroup(group);
      if (!clean) return null;

      const memberIdMap = Object.create(null);
      const newMembers = clean.members.map(m => {
        const newId = uid();
        memberIdMap[m.id] = newId;
        return { id: newId, name: m.name };
      });
      const newExpenses = clean.expenses.map(e => ({
        id: uid(),
        description: e.description,
        amount: e.amount,
        // If the original payer was remapped, follow the new id.
        // Otherwise keep the original (UI tolerates "unknown").
        paidBy: memberIdMap[e.paidBy] || e.paidBy,
        createdAt: e.createdAt,
      }));
      const copy = {
        id: uid(),
        name: `${clean.name} (imported)`,
        members: newMembers,
        expenses: newExpenses,
        createdAt: Date.now(),
      };
      this._data.groups.push(copy);
      this.save();
      return copy;
    },

    addMember(groupId, name) {
      const g = this.getGroup(groupId);
      if (!g) return null;
      const member = { id: uid(), name: name.trim() };
      g.members.push(member);
      this.save();
      return member;
    },

    updateMember(groupId, memberId, name) {
      const g = this.getGroup(groupId);
      if (!g) return false;
      const m = g.members.find(x => x.id === memberId);
      if (!m) return false;
      const trimmed = (name || '').trim();
      if (!trimmed) return false;
      // Reject duplicates (case-insensitive), excluding self.
      const dup = g.members.some(
        x => x.id !== memberId && x.name.toLowerCase() === trimmed.toLowerCase(),
      );
      if (dup) return false;
      m.name = trimmed;
      this.save();
      return true;
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

    updateExpense(groupId, expenseId, { description, amount, paidBy }) {
      const g = this.getGroup(groupId);
      if (!g) return false;
      const e = g.expenses.find(x => x.id === expenseId);
      if (!e) return false;
      if (description != null) e.description = String(description).trim();
      if (amount != null) e.amount = Number(amount);
      if (paidBy != null) e.paidBy = paidBy;
      this.save();
      return true;
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

  /* ---------- 2b. Export / Import ----------
   * Splitr exports a single group as a JSON document with a format
   * marker, so unrelated JSON files are rejected cleanly on import.
   * No conversion / merging is performed — the recipient gets a
   * snapshot, and conflicts are resolved at the point of import. */

  const EXPORT_FORMAT = 'splitr-group/1';

  function exportGroup(group) {
    return {
      splitrFormat: EXPORT_FORMAT,
      exportedAt: Date.now(),
      group: {
        id: group.id,
        name: group.name,
        createdAt: group.createdAt,
        members: group.members.map(m => ({ id: m.id, name: m.name })),
        expenses: group.expenses.map(e => ({
          id: e.id,
          description: e.description,
          amount: e.amount,
          paidBy: e.paidBy,
          createdAt: e.createdAt,
        })),
      },
    };
  }

  function parseImport(text) {
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('Not a valid JSON file'); }
    if (!data || data.splitrFormat !== EXPORT_FORMAT || !data.group) {
      throw new Error('Not a Splitr export file');
    }
    return data.group;
  }

  // Defensive normalisation: trims, coerces, drops malformed entries.
  // Returns null if the group can't be salvaged.
  function sanitizeImportedGroup(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : uid();
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) return null;
    const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();

    const members = Array.isArray(raw.members) ? raw.members : [];
    const cleanMembers = [];
    const seenMemberIds = new Set();
    for (const m of members) {
      if (!m || typeof m !== 'object') continue;
      const mid = typeof m.id === 'string' && m.id ? m.id : uid();
      if (seenMemberIds.has(mid)) continue;
      const mname = typeof m.name === 'string' ? m.name.trim() : '';
      if (!mname) continue;
      seenMemberIds.add(mid);
      cleanMembers.push({ id: mid, name: mname });
    }

    const expenses = Array.isArray(raw.expenses) ? raw.expenses : [];
    const cleanExpenses = [];
    const seenExpenseIds = new Set();
    for (const e of expenses) {
      if (!e || typeof e !== 'object') continue;
      const eid = typeof e.id === 'string' && e.id ? e.id : uid();
      if (seenExpenseIds.has(eid)) continue;
      const desc = typeof e.description === 'string' ? e.description.trim() : '';
      const amt = Number(e.amount);
      const paidBy = typeof e.paidBy === 'string' ? e.paidBy : '';
      const eCreatedAt = Number.isFinite(e.createdAt) ? e.createdAt : Date.now();
      if (!desc || !Number.isFinite(amt) || amt <= 0) continue;
      seenExpenseIds.add(eid);
      cleanExpenses.push({
        id: eid,
        description: desc,
        amount: amt,
        paidBy,
        createdAt: eCreatedAt,
      });
    }

    return { id, name, createdAt, members: cleanMembers, expenses: cleanExpenses };
  }

  /* ---------- 3. Router ---------- */
  // Routes:
  //   #/                              -> groups list
  //   #/group/:id                     -> group detail
  //   #/group/:id/add                 -> add expense form
  //   #/group/:id/edit/:expenseId     -> edit expense form

  const Router = {
    parse() {
      const hash = location.hash.replace(/^#/, '') || '/';
      const parts = hash.split('/').filter(Boolean);
      if (parts.length === 0) return { name: 'groups' };
      if (parts[0] === 'group' && parts[1]) {
        if (parts[2] === 'add') {
          return { name: 'expenseForm', groupId: parts[1], expenseId: null };
        }
        if (parts[2] === 'edit' && parts[3]) {
          return { name: 'expenseForm', groupId: parts[1], expenseId: parts[3] };
        }
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

  // Resolve an imported group into local storage. If the same group id
  // already exists locally, the user picks between replacing it or
  // keeping both (imported as a new copy with fresh ids).
  function handleGroupImport(incoming) {
    const existing = Store.getGroup(incoming.id);
    if (existing) {
      const replace = window.confirm(
        `You already have "${existing.name}".\n\n` +
        'OK = Replace your local copy with the imported one.\n' +
        'Cancel = Keep both — import as a separate "(imported)" group.'
      );
      if (replace) {
        const saved = Store.replaceGroup(incoming);
        if (!saved) { toast('Import failed: file is malformed'); return; }
        toast('Group replaced from import');
        Router.go(`/group/${saved.id}`);
      } else {
        const copy = Store.addGroupAsCopy(incoming);
        if (!copy) { toast('Import failed: file is malformed'); return; }
        toast('Imported as new copy');
        Router.go(`/group/${copy.id}`);
      }
    } else {
      const saved = Store.replaceGroup(incoming);
      if (!saved) { toast('Import failed: file is malformed'); return; }
      toast('Group imported');
      Router.go(`/group/${saved.id}`);
    }
  }

  function render() {
    const route = Router.parse();
    app.innerHTML = '';

    switch (route.name) {
      case 'groups':
        return renderGroups();
      case 'group':
        return renderGroupDetail(route.groupId);
      case 'expenseForm':
        return renderExpenseForm(route.groupId, route.expenseId);
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

    // Import a group
    wrap.appendChild(el('div', { class: 'section-title' }, 'Or import a group'));
    const importCard = el('div', { class: 'card' });
    const importIntro = el('p', { class: 'muted', style: 'margin: 0 0 12px; font-size: 13px;' },
      'Got a Splitr export from someone? Import their JSON file to add the group locally — you can edit your own copy from there.');
    const fileInput = el('input', {
      type: 'file',
      accept: 'application/json,.json',
      'aria-hidden': 'true',
      style: 'position:absolute; left:-9999px;',
    });
    const importBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-block' }, 'Import from JSON file');
    importCard.append(importIntro, importBtn, fileInput);
    wrap.appendChild(importCard);

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const incoming = parseImport(String(reader.result));
          handleGroupImport(incoming);
        } catch (err) {
          toast(err && err.message ? err.message : 'Import failed');
        } finally {
          fileInput.value = '';
        }
      };
      reader.onerror = () => { toast('Could not read file'); fileInput.value = ''; };
      reader.readAsText(file);
    });

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
              `${g.members.length} member${g.members.length === 1 ? '' : 's'} · ${formatAmount(total)} total`),
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
    const editGroupBtn = pencilButton('Edit group name', () => {
      const next = window.prompt('Group name', group.name);
      if (next == null) return;
      const trimmed = next.trim();
      if (!trimmed) { toast('Name cannot be empty'); return; }
      if (trimmed === group.name) return;
      if (Store.updateGroup(group.id, trimmed)) {
        toast('Group renamed');
        render();
      }
    });
    const summary = el('div', { class: 'card group-summary' },
      el('div', { class: 'summary-head' },
        el('span', { class: 'meta' }, 'Total spent'),
        editGroupBtn,
      ),
      el('span', { class: 'total' }, formatAmount(totalSpent(group))),
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

    // Share / Export
    wrap.appendChild(el('div', { class: 'section-title' }, 'Share this group'));
    const shareCard = el('div', { class: 'card' });
    const shareIntro = el('p', { class: 'muted', style: 'margin: 0 0 12px; font-size: 13px;' },
      'Export this group as JSON. Anyone you share it with can import it into Splitr on their device and continue editing their copy.');
    const dlBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Download JSON');
    const copyBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Copy to clipboard');
    const shareRow = el('div', { class: 'row' }, dlBtn, copyBtn);
    shareCard.append(shareIntro, shareRow);
    wrap.appendChild(shareCard);

    dlBtn.addEventListener('click', () => {
      const data = exportGroup(group);
      const filename = `splitr-${slugify(group.name)}-${fileDateStamp()}.json`;
      downloadJson(filename, data);
      toast('Group exported');
    });
    copyBtn.addEventListener('click', async () => {
      const data = exportGroup(group);
      const text = JSON.stringify(data, null, 2);
      const ok = await copyToClipboard(text);
      if (ok) toast('Copied to clipboard');
      else { window.prompt('Copy this JSON manually:', text); }
    });

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
        el('div', { class: 'amt' }, formatAmount(e.amount)),
      );
      const editBtn = el('button', {
        class: 'row-action edit',
        'aria-label': 'Edit expense',
        title: 'Edit',
      });
      editBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
      editBtn.addEventListener('click', () => {
        Router.go(`/group/${group.id}/edit/${e.id}`);
      });

      const del = el('button', {
        class: 'row-action del',
        'aria-label': 'Delete expense',
        title: 'Delete',
      });
      del.innerHTML =
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>';
      del.addEventListener('click', () => {
        if (confirm(`Delete "${e.description}"?`)) {
          Store.deleteExpense(group.id, e.id);
          toast('Expense deleted');
          render();
        }
      });
      row.append(editBtn, del);
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
        const nameBtn = el('button', {
          class: 'chip-name',
          type: 'button',
          title: 'Click to rename',
          'aria-label': `Rename ${m.name}`,
        });
        nameBtn.append(
          el('span', { class: 'chip-avatar' }, initials(m.name)),
          el('span', {}, m.name),
        );
        nameBtn.addEventListener('click', () => {
          const next = window.prompt('Member name', m.name);
          if (next == null) return;
          const trimmed = next.trim();
          if (!trimmed) { toast('Name cannot be empty'); return; }
          if (trimmed === m.name) return;
          if (Store.updateMember(group.id, m.id, trimmed)) {
            toast('Member renamed');
            render();
          } else {
            toast('Member already exists');
          }
        });

        const x = el('button', {
          class: 'chip-x',
          type: 'button',
          'aria-label': `Remove ${m.name}`,
          title: 'Remove',
        }, '×');
        x.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (confirm(`Remove ${m.name} from this group?`)) {
            Store.deleteMember(group.id, m.id);
            render();
          }
        });

        chip.append(nameBtn, x);
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
        ? `gets back ${formatAmount(v)}`
        : v < -0.005
          ? `owes ${formatAmount(-v)}`
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
          el('span', { class: 'amt' }, formatAmount(t.amount)),
        );
        slist.appendChild(row);
      }
      wrap.appendChild(slist);
    }

    return wrap;
  }

  /* --- Add / Edit expense form ---
   * If expenseId is provided, the form is in "edit" mode: fields are
   * prefilled and submit calls Store.updateExpense. Otherwise it's
   * "add" mode and submit calls Store.addExpense. */
  function renderExpenseForm(groupId, expenseId) {
    const group = Store.getGroup(groupId);
    if (!group) {
      setHeader('Not found', { showBack: true });
      app.appendChild(emptyState('Group not found', '', '🤔'));
      return;
    }
    const editing = expenseId
      ? group.expenses.find(e => e.id === expenseId) || null
      : null;
    if (expenseId && !editing) {
      setHeader('Not found', { showBack: true });
      app.appendChild(emptyState('Expense not found', 'It may have been deleted.', '🤔'));
      return;
    }
    if (group.members.length === 0) {
      setHeader(editing ? 'Edit expense' : 'Add expense', { showBack: true });
      app.appendChild(emptyState('No members', 'Add members before creating an expense.', '👤'));
      return;
    }

    setHeader(editing ? 'Edit expense' : 'Add expense', { showBack: true });

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
    paidBySelect.appendChild(el('option', { value: '', disabled: 'true' }, 'Select payer'));
    for (const m of group.members) {
      paidBySelect.appendChild(el('option', { value: m.id }, m.name));
    }

    if (editing) {
      descInput.value = editing.description;
      amountInput.value = String(editing.amount);
      paidBySelect.value = editing.paidBy;
    }

    const sharePreview = el('div', { class: 'hint' },
      `Splits equally across ${group.members.length} member${group.members.length === 1 ? '' : 's'}.`);

    const updatePreview = () => {
      const amt = Number(amountInput.value);
      if (amt > 0) {
        const share = amt / group.members.length;
        sharePreview.textContent =
          `Each member's share: ${formatAmount(share)} (across ${group.members.length})`;
      } else {
        sharePreview.textContent =
          `Splits equally across ${group.members.length} member${group.members.length === 1 ? '' : 's'}.`;
      }
    };
    amountInput.addEventListener('input', updatePreview);
    if (editing) updatePreview();

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
        el('button', { type: 'submit', class: 'btn btn-primary' },
          editing ? 'Save changes' : 'Add expense'),
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

      if (editing) {
        Store.updateExpense(group.id, editing.id, { description, amount, paidBy });
        toast('Expense updated');
      } else {
        Store.addExpense(group.id, { description, amount, paidBy });
        toast('Expense added');
      }
      Router.go(`/group/${group.id}`);
    });

    card.appendChild(form);
    app.appendChild(card);
    if (!editing) descInput.focus();
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

  function pencilButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pencil-btn';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
    btn.addEventListener('click', onClick);
    return btn;
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

  // Display-only money formatting: prefixes the selected currency
  // symbol. Whole numbers render without decimals (e.g. ₹500),
  // fractional values render with up to 2 decimals (e.g. $20.50).
  // No conversion is ever applied to stored amounts.
  function formatAmount(amount) {
    const c = getCurrency();
    const num = Number(amount) || 0;
    const abs = Math.abs(num);
    const isWhole = Math.abs(abs - Math.round(abs)) < 0.005;
    let formatted;
    try {
      formatted = abs.toLocaleString(undefined, {
        minimumFractionDigits: isWhole ? 0 : 2,
        maximumFractionDigits: 2,
      });
    } catch {
      formatted = isWhole ? String(Math.round(abs)) : abs.toFixed(2);
    }
    const sign = num < 0 ? '-' : '';
    return `${sign}${c.symbol}${formatted}`;
  }

  function formatDate(ts) {
    try {
      return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch { return ''; }
  }

  function fileDateStamp(ts = Date.now()) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  function slugify(str) {
    return (str || 'group')
      .toString()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'group';
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }
    // Legacy fallback for non-secure contexts (e.g. file://).
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
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

  // Populate the header currency dropdown and re-render on change.
  function initCurrencySelector() {
    const select = document.getElementById('currencySelect');
    if (!select) return;
    const active = getCurrency();
    select.innerHTML = '';
    for (const c of CURRENCIES) {
      const opt = document.createElement('option');
      opt.value = c.code;
      opt.textContent = `${c.symbol} ${c.code}`;
      opt.title = c.name;
      select.appendChild(opt);
    }
    // Explicitly set the value AFTER appending so the dropdown
    // mirrors the active currency regardless of insertion order.
    select.value = active.code;
    // Also persist the resolved code so storage and UI agree.
    setCurrency(active.code);

    select.addEventListener('change', () => {
      setCurrency(select.value);
      render(); // refresh all amounts in place — no full reload
    });
  }

  Store.load();
  loadVersion();
  initCurrencySelector();
  window.addEventListener('hashchange', render);
  window.addEventListener('storage', (e) => {
    // Sync across tabs.
    if (e.key === STORAGE_KEY) {
      Store.load();
      render();
    } else if (e.key === CURRENCY_KEY) {
      const sel = document.getElementById('currencySelect');
      if (sel) sel.value = getCurrency().code;
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
