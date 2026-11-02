export namespace main {
	
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
	export class Editor {
	    id: string;
	    name: string;
	    app: string;
	
	    static createFrom(source: any = {}) {
	        return new Editor(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.app = source["app"];
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
	export class OpenRequest {
	    repo: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new OpenRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.repo = source["repo"];
	        this.error = source["error"];
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
	    threads: PRThread[];
	    comments: PRComment[];
	    truncated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PRDiscussion(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
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
	    author: string;
	    headRefName: string;
	    headRefOid: string;
	    baseRefName: string;
	    isDraft: boolean;
	    additions: number;
	    deletions: number;
	    changedFiles: number;
	    updatedAt: string;
	    reviewDecision: string;
	    mergeable: string;
	    group: string;
	
	    static createFrom(source: any = {}) {
	        return new PRInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.number = source["number"];
	        this.title = source["title"];
	        this.url = source["url"];
	        this.author = source["author"];
	        this.headRefName = source["headRefName"];
	        this.headRefOid = source["headRefOid"];
	        this.baseRefName = source["baseRefName"];
	        this.isDraft = source["isDraft"];
	        this.additions = source["additions"];
	        this.deletions = source["deletions"];
	        this.changedFiles = source["changedFiles"];
	        this.updatedAt = source["updatedAt"];
	        this.reviewDecision = source["reviewDecision"];
	        this.mergeable = source["mergeable"];
	        this.group = source["group"];
	    }
	}
	
	export class ReviewTarget {
	    base: string;
	    head: string;
	
	    static createFrom(source: any = {}) {
	        return new ReviewTarget(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.base = source["base"];
	        this.head = source["head"];
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
	    head: string;
	    ignoreWS: boolean;
	    fullFile?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Scope(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.repo = source["repo"];
	        this.base = source["base"];
	        this.head = source["head"];
	        this.ignoreWS = source["ignoreWS"];
	        this.fullFile = source["fullFile"];
	    }
	}
	export class SearchHit {
	    path: string;
	    line: number;
	    text: string;
	    ranges: number[][];
	
	    static createFrom(source: any = {}) {
	        return new SearchHit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.line = source["line"];
	        this.text = source["text"];
	        this.ranges = source["ranges"];
	    }
	}
	export class SearchQuery {
	    text: string;
	    caseSensitive: boolean;
	    word: boolean;
	    regex: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SearchQuery(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.text = source["text"];
	        this.caseSensitive = source["caseSensitive"];
	        this.word = source["word"];
	        this.regex = source["regex"];
	    }
	}
	export class SearchResult {
	    hits: SearchHit[];
	    truncated: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SearchResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hits = this.convertValues(source["hits"], SearchHit);
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
	export class UpdateInfo {
	    current: string;
	    latest: string;
	    url: string;
	    available: boolean;
	    installable: boolean;
	
	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.current = source["current"];
	        this.latest = source["latest"];
	        this.url = source["url"];
	        this.available = source["available"];
	        this.installable = source["installable"];
	    }
	}

}

