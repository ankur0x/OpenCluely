'use strict';

function syncInlinePickerLabel(select) {
    const trigger = select.previousElementSibling;
    const label = select.getAttribute('aria-label');
    const selected = select.selectedOptions[0]?.label;
    trigger.textContent = selected || label;
    trigger.setAttribute('aria-label', selected ? label + ': ' + selected : label);
    trigger.disabled = select.disabled || !select.options.length;
}

function setInlinePickerValue(select, value) {
    select.value = value;
    syncInlinePickerLabel(select);
}

for (const select of document.querySelectorAll('[data-inline-picker]')) {
    const picker = document.createElement('div');
    picker.className = 'inline-picker';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = select.className + ' inline-picker-trigger';
    trigger.setAttribute('aria-controls', select.id);
    trigger.setAttribute('aria-expanded', 'false');
    select.before(picker);
    picker.append(trigger, select);
    syncInlinePickerLabel(select);

    // A select with multiple visible rows is painted inside the Electron window.
    function setOpen(open) {
        if (open === !select.hidden) return;
        select.size = Math.max(2, Math.min(6, select.options.length));
        select.hidden = !open;
        trigger.setAttribute('aria-expanded', String(open));
        select.dispatchEvent(new Event('picker-layout-change'));
    }

    trigger.addEventListener('click', () => {
        const opening = select.hidden;
        setOpen(opening);
        if (opening) select.focus();
    });
    select.addEventListener('change', () => syncInlinePickerLabel(select));
    select.addEventListener('click', (event) => {
        if (event.target instanceof HTMLOptionElement) {
            setOpen(false);
            trigger.focus();
        }
    });
    select.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' || event.key === 'Enter') {
            event.preventDefault();
            setOpen(false);
            trigger.focus();
        }
    });
    picker.addEventListener('focusout', (event) => {
        if (!picker.contains(event.relatedTarget)) setOpen(false);
    });
    document.addEventListener('pointerdown', (event) => {
        if (!picker.contains(event.target)) setOpen(false);
    });
    new MutationObserver(() => syncInlinePickerLabel(select))
        .observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
}
