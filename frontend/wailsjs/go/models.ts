export namespace main {
	
	export class Commit {
	    hash: string;
	    short: string;
	    subject: string;
	    author: string;
	    date: string;
	
	    static createFrom(source: any = {}) {
	        return new Commit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hash = source["hash"];
	        this.short = source["short"];
	        this.subject = source["subject"];
	        this.author = source["author"];
	        this.date = source["date"];
	    }
	}
	export class DirEntry {
	    name: string;
	    path: string;
	    isRepo: boolean;
	
	    static createFrom(source: any = {}) {
	        return new DirEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.isRepo = source["isRepo"];
	    }
	}
	export class DirListing {
	    path: string;
	    parent: string;
	    isRepo: boolean;
	    entries: DirEntry[];
	
	    static createFrom(source: any = {}) {
	        return new DirListing(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.parent = source["parent"];
	        this.isRepo = source["isRepo"];
	        this.entries = this.convertValues(source["entries"], DirEntry);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class FileChange {
	    path: string;
	    oldPath?: string;
	    status: string;
	    added: number;
	    deleted: number;
	
	    static createFrom(source: any = {}) {
	        return new FileChange(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.oldPath = source["oldPath"];
	        this.status = source["status"];
	        this.added = source["added"];
	        this.deleted = source["deleted"];
	    }
	}
	export class HistoryEntry {
	    repo: string;
	    base: string;
	    file: string;
	    // Go type: time
	    openedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new HistoryEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.repo = source["repo"];
	        this.base = source["base"];
	        this.file = source["file"];
	        this.openedAt = this.convertValues(source["openedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class OpenRequest {
	    repo: string;
	    base: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new OpenRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.repo = source["repo"];
	        this.base = source["base"];
	        this.error = source["error"];
	    }
	}
	export class PRBase {
	    name: string;
	    commit: string;
	    fetched: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PRBase(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.commit = source["commit"];
	        this.fetched = source["fetched"];
	    }
	}
	export class PRComment {
	    author: string;
	    body: string;
	    url: string;
	    createdAt: string;
	
	    static createFrom(source: any = {}) {
	        return new PRComment(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.author = source["author"];
	        this.body = source["body"];
	        this.url = source["url"];
	        this.createdAt = source["createdAt"];
	    }
	}
	export class PRThread {
	    path: string;
	    line: number;
	    resolved: boolean;
	    outdated: boolean;
	    url: string;
	    comments: PRComment[];
	
	    static createFrom(source: any = {}) {
	        return new PRThread(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.line = source["line"];
	        this.resolved = source["resolved"];
	        this.outdated = source["outdated"];
	        this.url = source["url"];
	        this.comments = this.convertValues(source["comments"], PRComment);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PRDiscussion {
	    number: number;
	    url: string;
	    threads: PRThread[];
	    comments: PRComment[];
	    truncated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PRDiscussion(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.number = source["number"];
	        this.url = source["url"];
	        this.threads = this.convertValues(source["threads"], PRThread);
	        this.comments = this.convertValues(source["comments"], PRComment);
	        this.truncated = source["truncated"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class PRInfo {
	    id: string;
	    number: number;
	    title: string;
	    url: string;
	    baseRefName: string;
	    headRefOid: string;
	    baseRefOid: string;
	    mergeable: string;
	    state: string;
	
	    static createFrom(source: any = {}) {
	        return new PRInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.number = source["number"];
	        this.title = source["title"];
	        this.url = source["url"];
	        this.baseRefName = source["baseRefName"];
	        this.headRefOid = source["headRefOid"];
	        this.baseRefOid = source["baseRefOid"];
	        this.mergeable = source["mergeable"];
	        this.state = source["state"];
	    }
	}
	
	export class RevertResult {
	    reverted: string[];
	    skipped: string[];
	
	    static createFrom(source: any = {}) {
	        return new RevertResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.reverted = source["reverted"];
	        this.skipped = source["skipped"];
	    }
	}
	export class RunResult {
	    output: string;
	    exitCode: number;
	    timedOut: boolean;
	
	    static createFrom(source: any = {}) {
	        return new RunResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.output = source["output"];
	        this.exitCode = source["exitCode"];
	        this.timedOut = source["timedOut"];
	    }
	}
	export class Scope {
	    repo: string;
	    base: string;
	    commit: string;
	    ignoreWS: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Scope(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.repo = source["repo"];
	        this.base = source["base"];
	        this.commit = source["commit"];
	        this.ignoreWS = source["ignoreWS"];
	    }
	}
	export class SyncResult {
	    number: number;
	    marked: number;
	    alreadyDone: number;
	    notInPR: number;
	
	    static createFrom(source: any = {}) {
	        return new SyncResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.number = source["number"];
	        this.marked = source["marked"];
	        this.alreadyDone = source["alreadyDone"];
	        this.notInPR = source["notInPR"];
	    }
	}
	export class UpdateInfo {
	    current: string;
	    latest: string;
	    url: string;
	    available: boolean;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.current = source["current"];
	        this.latest = source["latest"];
	        this.url = source["url"];
	        this.available = source["available"];
	    }
	}
	export class Worktree {
	    path: string;
	    branch: string;
	    head: string;
	    detached: boolean;
	    bare: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Worktree(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.branch = source["branch"];
	        this.head = source["head"];
	        this.detached = source["detached"];
	        this.bare = source["bare"];
	    }
	}

}

