const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings; //connect settings-schema.json to the this variable
const Util = imports.misc.util;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;
const Gettext = imports.gettext;
const Main = imports.ui.main;

let UUID;   // set in main() from metadata (more practical when testing with the dev prefix)

// underscore function is standard for translation, cinnamon already has a global _() func 
function _(text) {
    return Gettext.dgettext(UUID, text);
}

// useful link: https://gjs.guide/extensions/review-guidelines/best-practices.html#avoid-spaghetti-cleanup

// IconApplet shows just an icon and no text in the task bar
class GithubReposApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.metadata = metadata;
        this._timerId = 0;
        this._cache = {};        // maps "owner/name" to {author,date} or {error} if fetch fails
        this._lastCommitId = {}; // maps "owner/name" to the id of the newest commit
        this._generation = 0;    // this is used to ignore older request when refreshing

        // allow horizontal and vertical panels
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        // icon is "repo" from github Octicons https://primer.style/octicons/icon/repo-16/
        this.set_applet_icon_symbolic_path(this.metadata.path + "/imgs/repo-symbolic.svg");
        this.set_applet_tooltip(_("GitHub repositories"));

        // HTTP session Soup 3 is required
        this._session = new Soup.Session();

        // bind(key in settings-schema.json, property name on this, function called when the user changes it)
        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        this.settings.bind("repos", "repos", this.refreshAll);
        this.settings.bind("token", "token", this.refreshAll);
        this.settings.bind("refresh-interval", "refreshInterval", this.restartTimer);
        // this setting just maps to a variable
        this.settings.bind("send-notifications", "sendNotifications");

        // popup menu when left clicking the applet, OOP stuff :)
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        // first refresh + start the automatic refresh
        this.restartTimer();
    }

    // settings give [{repo:"torvalds/linux"}] and we want ["torvalds/linux"]
    repoNames() {
        // trim and filters 0 length in case user puts white spaces by accident
        return this.repos.map(entry => entry.repo.trim()).filter(entry => entry.length>0);
    }

    // build the popup menu
    buildMenu() {
        // remove previous menu for simplicity
        this.menu.removeAll();

        const names = this.repoNames();

        if (names.length === 0) {
            // reactive: false, to just have plain text instead of clickable row
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(_("No repositories, add some in Settings"), { reactive: false }));
        }

        // each clickable repos
        for (const name of names) {
            this.menu.addMenuItem(this.repoItem(name));
        }

        // separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        this.menu.addAction(_("Refresh now"), () => this.refreshAll()); // note, lambda function is needed here unlike settings bind
    }

    // one row of the menu repo name
    repoItem(name) {
        const item = new PopupMenu.PopupBaseMenuItem();
        const box = new St.BoxLayout({ vertical: true });   // vertical: the two labels are stacked
        const title = new St.Label({ text: name, style: "font-weight: bold;" });    // repo name in bold
        const detail = new St.Label({ text: this.getLastCommitInfos(name), style: "font-size: 0.9em;" });   // author-time ago
        box.add_actor(title);
        box.add_actor(detail);
        item.addActor(box);

        // used to open the link of the repo ("activate" = the row is clicked)
        item.connect("activate", () => Util.spawn(["xdg-open", "https://github.com/" + name]));
        return item;
    }

    getLastCommitInfos(name) {
        const info = this._cache[name];
        if (!info) {
            return _("Loading…");   // request not answered yet
        }
        if (info.error) {
            return info.error;
        }
        // .format() replaces each %s in order here
        return _("%s - %s").format(info.author,this.timeAgo(info.date));
    }

    // example of conversion: "2024-05-01T10:00:00Z" to "3 hours ago"
    timeAgo(isoDate) {
        const date = GLib.DateTime.new_from_iso8601(isoDate, null);
        // difference() is in microseconds, 1 second = 1000000 microseconds
        const microseconds = GLib.DateTime.new_now_utc().difference(date);
        const minutes = Math.floor(microseconds / 1000000 / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (minutes < 1) return _("just now");
        // dngettext(domain, singular, plural, number) outputs "minute" or "minutes" depending on the number, very handy !
        if (minutes < 60) return Gettext.dngettext(UUID, "%d minute ago", "%d minutes ago", minutes).format(minutes);
        if (hours < 24) return Gettext.dngettext(UUID, "%d hour ago", "%d hours ago", hours).format(hours);
        return Gettext.dngettext(UUID, "%d day ago", "%d days ago", days).format(days);
    }

    refreshAll() {
        this._generation++;        // new refresh number
        this._session.abort();     // cancel the old requests
        this._cache = {};
        this.buildMenu();         // every row displays "Loading…"

        // each callback below remembers the refresh number it was started with
        // if a newer refresh started in the meantime its answer is too old and we ignore it
        const generation = this._generation;
        for (const name of this.repoNames()) {
            this.fetch(name, (status, body, rateLimited) => {
                if (generation !== this._generation) return;
                // update the commit
                const commit = this.parse(status, body, rateLimited);
                this._cache[name] = commit;

                // send notification if new commit
                // if checks in case the callback fails and commit is undefined
                if (commit.id) {
                    let previousId = this._lastCommitId[name];
                    // second check to avoid sending notification on the first update
                    if (this.sendNotifications && previousId && previousId !== commit.id) {
                        Main.notify(_("New commit in %s").format(name),"%s - %s".format(commit.author, this.timeAgo(commit.date)));
                    }
                    this._lastCommitId[name] = commit.id;
                }

                this.buildMenu();   // rebuild the menu with the updated info
            });
        }
    }

    // transform the HTTP answer into {author:..., date:...}
    parse(status, body, rateLimited) {
        if (status === 200) {
            const commit = JSON.parse(body)[0];   // the answer is a list with only the newest commit
            return {
                author: commit.commit.author.name || _("unknown"),
                date: commit.commit.author.date,
                id: commit.sha   // id of the commit
            };
        }
        if (status === 404) return { error: _("Repository not found") };
        if (status === 401) return { error: _("Invalid token, please check Settings") };
        if (rateLimited) return { error: _("Rate limit reached, please add a token in settings") };
        return { error: _("Request failed (%s)").format(String(status)) };
    }

    // sends the request without blocking the desktop, uses REST for now (graphQL is also an option)
    // the answer arrives later, so instead of returning it we give it to callback(status, body, rateLimited)
    fetch(name, callback) {
        //per_page=1 to retrieve only the newest commit
        const url = `https://api.github.com/repos/${name}/commits?per_page=1`;
        const message = Soup.Message.new("GET", url);
        if (!message) {
            // name set cannot form a valid URL
            callback(404, null, false);
            return;
        }
        message.request_headers.append("User-Agent", "cinnamon-" + UUID);   // github refuses requests without it apparently
        message.request_headers.append("Accept", "application/vnd.github+json");
        if (this.token.trim()) {
            message.request_headers.append("Authorization", "Bearer " + this.token.trim());
        }

        // this function runs when github has answered
        // https://valadoc.org/libsoup-3.0/Soup.Session.send_and_read_async.html
        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            let body;
            try {
                const bytes = session.send_and_read_finish(result); // results are sent as bytes
                body = new TextDecoder().decode(bytes.get_data());   // raw bytes to text
            } catch (e) {
                // cancelled by abort()
                callback(0, null, false);
                return;
            }
            const status = message.get_status();
            // github answers 403 or 429 with x-ratelimit-remaining to 0 when rate limit hits
            const rateLimited = (status === 403 || status === 429) && message.response_headers.get_one("x-ratelimit-remaining") === "0";
            callback(status, body, rateLimited);
        });
    }

    restartTimer() {
        this.stopTimer();
        // initial repo refresh done here otherwise we would have to wait a full timer cooldown
        this.refreshAll();
        // call refreshAll() every refreshInterval minutes (the function takes seconds)
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this.refreshInterval * 60, () => {
            this.refreshAll();
            return GLib.SOURCE_CONTINUE;   // continue the timer
        });
    }

    stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    on_applet_clicked(event) {
        if (!this.menu.isOpen) this.buildMenu();
        this.menu.toggle();
    }

    // required for applets contributions
    on_applet_removed_from_panel(deleteConfig) {
        this.stopTimer();
        this._generation++;        // safe measure to ignore callbacks after removing the applet
        this._session.abort();     // cut off the http session
        this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    UUID = metadata.uuid;
    // for translations, use GLib.get_user_data_dir() because github actions warnings says so 
    Gettext.bindtextdomain(UUID, GLib.get_user_data_dir() + "/locale");
    return new GithubReposApplet(metadata, orientation, panelHeight, instanceId);
}
