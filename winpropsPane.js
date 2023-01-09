'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Gdk = imports.gi.Gdk;

const ExtensionUtils = imports.misc.extensionUtils;
const Extension = ExtensionUtils.getCurrentExtension();
const Convenience = Extension.imports.convenience;
const Settings = Extension.imports.settings;

var WinpropsPane = GObject.registerClass({
    GTypeName: 'WinpropsPane',
    Template: Extension.dir.get_child('WinpropsPane.ui').get_uri(),
    InternalChildren: [
        'search',
        'listbox',
        'addButton',
        'scrolledWindow',
    ],
    Signals: {
        'changed': {},
    }
}, class WinpropsPane extends Gtk.Box {
    _init(params = {}) {
        super._init(params);

        this._listbox.set_filter_func(row => {
            let search = this._search.get_text();
            return row.winprop.wm_class.includes(search) || row._accelLabel.label.includes(search);
        });
        this._search.connect('changed', () => {
            this._listbox.invalidate_filter();
        });

        this._expandedRow = null;
        this.rows = [];
    }

    addWinprops(winprops) {
        winprops.forEach(winprop => {
            this._listbox.insert(this._createRow(winprop), -1);
        });
    }

    _removeRow(row) {
        this._listbox.remove(row);
        let remove = this.rows.findIndex(r => r === row);
        if (remove >= 0) {
            this.rows.splice(remove, 1);
        }
        this.emit('changed');
    }

    _onAddButtonClicked() {
        // first clear search text, otherwise won't be able to see new row
        this._search.set_text('');

        let row = this._createRow();
        row.expanded = true;
        this._listbox.insert(row, 0);
        this._scrolledWindow.get_vadjustment().set_value(0);
    }

    _createRow(winprop) {
        let wp = winprop ?? {wm_class:''};
        const row = new WinpropsRow({winprop : wp});
        this.rows.push(row);
        row.connect('notify::expanded', (row) => this._onRowExpanded(row));
        row.connect('row-deleted', (row) => this._removeRow(row));
        row.connect('changed', () => this.emit('changed'));
        return row;
    }

    _onRowActivated(list, row) {
        if (!row.is_focus()) return;
        row.expanded = !row.expanded;
    }

    _onRowExpanded(row) {
        if (row.expanded) {
            if (this._expandedRow) {
                this._expandedRow.expanded = false;
            }
            this._expandedRow = row;
        } else if (this._expandedRow === row) {
            this._expandedRow = null;
        }
    }
});

var WinpropsRow = GObject.registerClass({
    GTypeName: 'WinpropsRow',
    Template: Extension.dir.get_child('WinpropsRow.ui').get_uri(),
    InternalChildren: [
        'header',
        'descLabel',
        'accelLabel',
        'revealer',
        'optionList',
        'wmClass',
        'scratchLayer',
        'preferredWidth',
        'deleteButton',
    ],
    Properties: {
        winprop: GObject.ParamSpec.jsobject(
            'winprop',
            'winprop',
            'Winprop',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
        ),
        expanded: GObject.ParamSpec.boolean(
            'expanded',
            'Expanded',
            'Expanded',
            GObject.ParamFlags.READWRITE,
            false
        ),
    },
    Signals: {
        'changed': {},
        'row-deleted': {},
    }
}, class WinpropsRow extends Gtk.ListBoxRow {
    _init(params = {}) {
        super._init(params);        

        // set the values to current state and connect to 'changed' signal
        this._descLabel.label = this.winprop.wm_class;
        this._wmClass.set_text(this.winprop.wm_class);
        this._wmClass.connect('changed', () => {
            // check if null or empty (we still emit changed if wm_class is wiped)
            if (!this._wmClass.get_text()) {
                this._setError(this._wmClass);
            } else {
                this._setError(this._wmClass, false);
            }
            this.winprop.wm_class = this._wmClass.get_text();
            this._descLabel.label = this.winprop.wm_class;
            this.emit('changed');
        });

        this._scratchLayer.set_active(this.winprop.scratch_layer ?? false);
        this._scratchLayer.connect('state-set', () => {
            let isActive = this._scratchLayer.get_active();
            this.winprop.scratch_layer = isActive;

            // if is active then disable the preferredWidth input
            this._preferredWidth.set_sensitive(!isActive);

            this.emit('changed');
        })

        this._preferredWidth.set_text(this.winprop.preferredWidth ?? '');
        // if scratchLayer is active then users can't edit preferredWidth
        this._preferredWidth.set_sensitive(!this.winprop.scratch_layer ?? true);

        this._preferredWidth.connect('changed', () => {
            // if has value, needs to be valid (have a value or unit)
            if (this._preferredWidth.get_text()) {
                let value = this._preferredWidth.get_text();
                let digits = (value.match(/\d+/) ?? [null])[0];
                let isPercent = /^.*%$/.test(value);
                let isPixel = /^.*px$/.test(value);
                
                // check had valid number
                if (!digits) {
                    this._setError(this._preferredWidth);
                }
                // if no unit defined
                else if (!isPercent && !isPixel) {
                    this._setError(this._preferredWidth);
                }
                else {
                    this._setError(this._preferredWidth, false);
                    this.winprop.preferredWidth = this._preferredWidth.get_text();
                    this.emit('changed');
                }
            } else {
                // having no preferredWidth is valid
                this._setError(this._preferredWidth, false);
                delete this.winprop.preferredWidth;
                this.emit('changed');
            }
        });

        this._updateState();
    }

    _setError(child, option = true) {
        if (child) {
            if (option) {
                child.add_css_class('error');
            } else {
                child.remove_css_class('error');
            }
        }
    }

    get expanded() {
        if (this._expanded === undefined)
            this._expanded = false;
        return this._expanded;
    }

    set expanded(value) {
        if (this._expanded === value)
            return;

        this._expanded = value;
        this.notify('expanded');
        this._updateState();
    }

    _onDeleteButtonClicked() {
        this.emit('row-deleted');
    }

    _onRowActivated(list, row) {
        if (row.is_focus()) {
            row.editing = !row.editing;
        }
    }

    _setAccelLabel() {
        let isScratch = this.winprop.scratch_layer ?? false;
        let isPreferredWidth = this.winprop.preferredWidth || false;

        if (isScratch) {
            return 'scratch layer';
        }
        else if (isPreferredWidth) {
            return 'preferred width';
        } else {
            return 'no setting';
        }
    }

    _updateState() {
        GLib.idle_add(0, () => {
            this._accelLabel.label = this._setAccelLabel();
            if (this.expanded) {
                this._accelLabel.hide();
                this._revealer.reveal_child = true;
                this.add_css_class('expanded');
            } else {
                this._accelLabel.show();
                this._revealer.reveal_child = false;
                this.remove_css_class('expanded');
            }
        });
    }
});