const Module = imports.misc.extensionUtils.getCurrentExtension().imports.module;
var {GLib, Clutter, Meta, GObject} = imports.gi;
var St = imports.gi.St;
var GdkPixbuf = imports.gi.GdkPixbuf;
var Cogl = imports.gi.Cogl;
var Main = imports.ui.main;
var Mainloop = imports.mainloop;

var workspaceManager = global.workspace_manager;
var display = global.display;
var WindowTracker = imports.gi.Shell.WindowTracker;

var version = imports.misc.config.PACKAGE_VERSION.split('.').map(Number);
var registerClass = GObject.registerClass;

var debug_all = false; // Turn off by default
var debug_filter = {'#paperwm': true, '#stacktrace': true};
function debug() {
    let keyword = arguments[0];
    let filter = debug_filter[keyword];
    if (filter === false)
        return;
    if (debug_all || filter === true)
        log(Array.prototype.join.call(arguments, " | "));
}

function warn(...args) {
    log("WARNING:", ...args);
}

function assert(condition, message, ...dump) {
    if (!condition) {
        throw new Error(message + "\n", dump);
    }
}

function withTimer(message, fn) {
    let start = GLib.get_monotonic_time();
    let ret = fn();
    let stop = GLib.get_monotonic_time();
    log(`${message} ${((stop - start)/1000).toFixed(1)}ms`);
}

function print_stacktrace(error) {
    let trace;
    if (!error) {
        trace = (new Error()).stack.split("\n");
        // Remove _this_ frame
        trace.splice(0, 1);
    } else {
        trace = error.stack.split("\n");
    }
    // Remove some uninteresting frames
    let filtered = trace.filter((frame) => {
        return frame !== "wrapper@resource:///org/gnome/gjs/modules/lang.js:178";
    });
    log(`JS ERROR: ${error}\n ${trace.join('\n')}`);
}

function framestr(rect) {
    return "[ x:"+rect.x + ", y:" + rect.y + " w:" + rect.width + " h:"+rect.height + " ]";
}

/**
 * Returns a human-readable enum value representation
 */
function ppEnumValue(value, genum) {
    let entry = Object.entries(genum).find(([k, v]) => v === value);
    if (entry) {
        return `${entry[0]} (${entry[1]})`
    } else {
        return `<not-found> (${value})`
    }
}

function ppModiferState(state) {
    let mods = [];
    for (let [mod, mask] of Object.entries(Clutter.ModifierType)) {
        if (mask & state) {
            mods.push(mod);
        }
    }
    return mods.join(", ")
}

/**
 * Look up the function by name at call time. This makes it convenient to
 * redefine the function without re-registering all signal handler, keybindings,
 * etc. (this is like a function symbol in lisp)
 */
function dynamic_function_ref(handler_name, owner_obj) {
    owner_obj = owner_obj || window;
    return function() {
        owner_obj[handler_name].apply(this, arguments);
    }
}

/**
   Find the first x in `values` that's larger than `cur`.
   Cycle to first value if no larger value is found.
   `values` should be sorted in ascending order.
 */
function findNext(cur, values, slack=0) {
    for (let i = 0; i < values.length; i++) {
        let x = values[i];
        if (cur < x) {
            if (x - cur < slack) {
                // Consider `cur` practically equal to `x`
                continue;
            } else {
                return x;
            }
        }
    }
    return values[0]; // cycle
}

function arrayEqual(a, b) {
    if (a === b)
        return true;
    if (!a || !b)
        return false;
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return false;
    }
    return true;
}

/** Is the floating point numbers equal enough */
function eq(a, b, epsilon=0.00000001) {
    return Math.abs(a-b) < epsilon;
}

function swap(array, i, j) {
    let temp = array[i];
    array[i] = array[j];
    array[j] = temp;
}

function in_bounds(array, i) {
    return i >= 0 && i < array.length;
}

function isPointInsideActor(actor, x, y) {
    return (actor.x <= x && x <= actor.x+actor.width)
        && (actor.y <= y && y <= actor.y+actor.height);
}

function setBackgroundImage(actor, resource_path) {
    // resource://{resource_path}
    let image = new Clutter.Image();

    let pixbuf = GdkPixbuf.Pixbuf.new_from_resource(resource_path)

    image.set_data(pixbuf.get_pixels() ,
                   pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888
                   : Cogl.PixelFormat.RGB_888,
                   pixbuf.get_width() ,
                   pixbuf.get_height() ,
                   pixbuf.get_rowstride());
    actor.set_content(image);
    actor.content_repeat = Clutter.ContentRepeat.BOTH
}


//// Debug and development utils

function setDevGlobals() {
    // Accept the risk of this interfering with existing code for now
    metaWindow = display.focus_window;
    meta_window = display.focus_window;
    workspace = workspaceManager.get_active_workspace();
    actor = metaWindow.get_compositor_private();
    space = Module.Tiling().spaces.spaceOfWindow(metaWindow);
    app = WindowTracker.get_default().get_window_app(metaWindow);
}

/**
 * Visualize the frame and buffer bounding boxes of a meta window
 */
function toggleWindowBoxes(metaWindow) {
    metaWindow = metaWindow || display.focus_window;

    if(metaWindow._paperDebugBoxes) {
        metaWindow._paperDebugBoxes.forEach(box => {
            box.destroy();
        });
        delete metaWindow._paperDebugBoxes;
        return [];
    }

    let frame = metaWindow.get_frame_rect()
    let inputFrame = metaWindow.get_buffer_rect()
    let actor = metaWindow.get_compositor_private();

    makeFrameBox = function({x, y, width, height}, color) {
        let frameBox = new St.Widget();
        frameBox.set_position(x, y)
        frameBox.set_size(width, height)
        frameBox.set_style("border: 2px" + color + " solid");
        return frameBox;
    }

    let boxes = [];

    boxes.push(makeFrameBox(frame, "red"));
    boxes.push(makeFrameBox(inputFrame, "blue"));

    if(inputFrame.x !== actor.x || inputFrame.y !== actor.y
       || inputFrame.width !== actor.width || inputFrame.height !== actor.height) {
        boxes.push(makeFrameBox(actor, "yellow"));
    }

    boxes.forEach(box => global.stage.add_actor(box));

    metaWindow._paperDebugBoxes = boxes;
    return boxes;
}

var markNewClonesSignalId = null;
function toggleCloneMarks() {
    // NB: doesn't clean up signal on disable

    function markCloneOf(metaWindow) {
        if (metaWindow.clone) {
            metaWindow.clone.opacity = 190;
            metaWindow.clone.__oldOpacity = 190;

            metaWindow.clone.background_color = Clutter.color_from_string("red")[1];
        }
    }
    function unmarkCloneOf(metaWindow) {
        if (metaWindow.clone) {
            metaWindow.clone.opacity = 255;
            metaWindow.clone.__oldOpacity = 255;
            metaWindow.clone.background_color = null;
        }
    }

    let windows = display.get_tab_list(Meta.TabList.NORMAL_ALL, null);

    if (markNewClonesSignalId) {
        display.disconnect(markNewClonesSignalId);
        markNewClonesSignalId = null;
        windows.forEach(unmarkCloneOf);
    } else {
        markNewClonesSignalId = display.connect_after(
            "window-created", (_, mw) => markCloneOf(mw))

        windows.forEach(markCloneOf);
    }
}

function sum(array) {
    return array.reduce((a, b) => a + b, 0);
}

function zip(...as) {
    let r = [];
    let minLength = Math.min(...as.map(x => x.length));
    for (let i = 0; i < minLength; i++) {
        r.push(as.map(a => a[i]));
    }
    return r;
}

function warpPointer(x, y) {
    let backend = Clutter.get_default_backend();
    let seat = backend.get_default_seat();
    seat.warp_pointer(x, y);
}

/**
 * Return current modifiers state (or'ed Clutter.ModifierType.*)
 */
function getModiferState() {
    let [x, y, mods] = global.get_pointer();
    return mods;
}

function monitorOfPoint(x, y) {
    // get_monitor_index_for_rect "helpfully" returns the primary monitor index for out of bounds rects..
    for (let monitor of Main.layoutManager.monitors) {
        if ((monitor.x <= x && x <= monitor.x+monitor.width) &&
            (monitor.y <= y && y <= monitor.y+monitor.height))
        {
            return monitor;
        }
    }

    return null;
}


function indent(level, str) {
    let blank = ""
    for (let i = 0; i < level; i++) {
        blank += "  "
    }
    return blank + str
}

function mkFmt({nameOnly}={nameOnly: false}) {
    function defaultFmt(actor, prefix="") {
        const fmtNum = num => num.toFixed(0);
        let extra = [
            `${actor.get_position().map(fmtNum)}`,
            `${actor.get_size().map(fmtNum)}`,
        ];
        let metaWindow = actor.meta_window || actor.metaWindow;
        if (metaWindow) {
            metaWindow = `(mw: ${metaWindow.title})`;
            extra.push(metaWindow);
        }
        const extraStr = extra.join(" | ");
        let actorId = "";
        if (nameOnly) {
            actorId = actor.name ? actor.name : (prefix.length == 0 ? "" : "#")
        } else {
            actorId = actor.toString();
        }
        actorId = prefix+actorId
        let spacing = actorId.length > 0 ? " " : ""
        return `*${spacing}${actorId} ${extraStr}`;
    }
    return defaultFmt;
}

function printActorTree(node, fmt=mkFmt(), options={}, state=null) {
    state = Object.assign({}, (state || {level: 0, actorPrefix: ""}))
    const defaultOptions = {
        limit: 9999,
        collapseChains: true,
    };
    options = Object.assign(defaultOptions, options)

    if (state.level > options.limit) {
        return;
    }
    let collapse = false;
    if (options.collapseChains) {
        /*
          a
            b
              s
              t
            c 30,10
              u
          ->
          a.b.s
          a.b.t 
          a.b.c ...
            u
        */
        if (node.get_children().length > 0) {
            if (node.x === 0 && node.y === 0) {
                state.actorPrefix += (node.name ? node.name : "#") + ".";
                collapse = true;
            } else {
                collapse = false;
            }
        } else {
            collapse = false;
        }
    }
    if (!collapse) {
        log(indent(state.level, fmt(node, state.actorPrefix)));
        state.actorPrefix = "";
        state.level += 1;
    }

    for (let child of node.get_children()) {
        printActorTree(child, fmt, options, state)
    }
}

var Signals = class Signals extends Map {
    static get [Symbol.species]() { return Map; }

    _getOrCreateSignals(object) {
        let signals = this.get(object);
        if (!signals) {
            signals = [];
            this.set(object, signals);
        }
        return signals;
    }

    connectOneShot(object, signal, handler) {
        let id = this.connect(object, signal, (...args) => {
            this.disconnect(object, id);
            return handler(...args);
        });
    }

    connect(object, signal, handler) {
        let id = object.connect(signal, handler);
        let signals = this._getOrCreateSignals(object);
        signals.push(id);
        return id;
    }

    disconnect(object, id=null) {
        let ids = this.get(object);
        if (ids) {
            if (id === null) {
                ids.forEach(id => object.disconnect(id));
                ids = [];
            } else {
                object.disconnect(id);
                let i = ids.indexOf(id);
                if (i > -1) {
                    ids.splice(i, 1);
                }
            }
            if (ids.length === 0)
                this.delete(object);
        }
    }

    destroy() {
        for (let [object, signals] of this) {
            signals.forEach(id => object.disconnect(id));
            this.delete(object);
        }
    }
};

/**
 * Note the name `Tweener` used previously was just a legacy name, we're actually using
 * Widget.ease here.  This was renamed to avoid confusion with the deprecated `Tweener`
 * moddule.
 */
var easer = {
    addEase(actor, params) {
        if (params.time) {
            params.duration = params.time * 1000;
            delete params.time;
        }
        if (!params.mode)
            params.mode = Clutter.AnimationMode.EASE_IN_OUT_QUAD;
        actor.ease(params);
    },

    removeEase(actor) {
        actor.remove_all_transitions();
    },

    isEasing(actor) {
        return actor.get_transition('x') || actor.get_transition('y') || actor.get_transition('scale-x') || actor.get_transition('scale-x');
    },
};

function isMetaWindow(obj) {
    return obj && obj.window_type && obj.get_compositor_private;
}

function trace(topic, ...args) {
    if (!topic.match(/.*/)) {
        return;
    }

    if (isMetaWindow(args[0])) {
        windowTrace(topic, ...args);
    } else {
        let trace = shortTrace(1).join(" < ");
        let extraInfo = args.length > 0 ? "\n\t" + args.map(x => x.toString()).join("\n\t") : ""
        log(topic, trace, extraInfo);
    }
}

let existingWindows = new Set();

function windowTrace(topic, metaWindow, ...rest) {
    if (existingWindows.has(metaWindow)) {
        return;
    }

    log(topic, infoMetaWindow(metaWindow).join("\n"), ...rest.join("\n"));
}

function infoMetaWindow(metaWindow) {
    let id = metaWindow.toString().split(" ")[4];
    let trace = shortTrace(3).join(" < ");
    let info = [
        `(win: ${id}) ${trace}`,
        `Title: ${metaWindow.title}`,
    ];
    if (!metaWindow.window_type === Meta.WindowType.NORMAL) {
        info.push(`Type: ${ppEnumValue(metaWindow.window_type, Meta.WindowType)}`);
    }
    if (!metaWindow.get_compositor_private()) {
        info.push(`- no actor`);
    }
    if (metaWindow.is_on_all_workspaces()) {
        info.push(`- is_on_all_workspaces`);
    }
    if (metaWindow.above) {
        info.push(`- above`);
    }
    if (Module.Scratch().isScratchWindow(metaWindow)) {
        info.push(`- scratch`);
    }
    return info;
}

function shortTrace(skip=0) {
    let trace = new Error().stack.split("\n").map(s => {
        let words = s.split(/[@/]/)
        let cols = s.split(":")
        let ln = parseInt(cols[2])
        if (ln === null)
            ln = "?"

        return [words[0], ln]
    });
    trace = trace.filter(([f, ln]) => f !== "dynamic_function_ref").map(([f, ln]) => f === "" ? "?" : f + ":" + ln);
    return trace.slice(skip + 1, skip + 5);
}

function actor_raise(actor, above) {
    const parent = actor.get_parent();
    if (!parent) {
        return;
    }
    // needs to be null (not undefined) for valid second argument
    above = above ?? null;
    parent.set_child_above_sibling(actor, above);
}

function actor_reparent(actor, newParent) {
    const parent = actor.get_parent();
    if (parent) {
        parent.remove_child(actor);
    }
    newParent.add_child(actor);
}

/**
 * Backwards compatible later_add function.
 */
function later_add(...args) {
    // Gnome 44+ uses global.compositor.get_laters()
    if (global.compositor?.get_laters) {
        global.compositor.get_laters().add(...args);
    }
    // Gnome 42, 43 used Meta.later_add
    else if (Meta.later_add) {
        Meta.later_add(...args);
    }
}

/**
 * Convenience method for removing a timeout source from Mainloop.
 */
function timeout_remove(timeoutId) {
    if (timeoutId) {
        Mainloop.source_remove(timeoutId);
    }
}
