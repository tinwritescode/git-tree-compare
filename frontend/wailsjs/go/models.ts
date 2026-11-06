export namespace main {
	
	export class CommitRef {
	    hash: string;
	    short: string;
	    subject: string;
	    author: string;
	    when: string;
	
	    static createFrom(source: any = {}) {
	        return new CommitRef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hash = source["hash"];
	        this.short = source["short"];
	        this.subject = source["subject"];
	        this.author = source["author"];
	        this.when = source["when"];
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
	    generated?: boolean;
	    whitespaceOnly?: boolean;
	
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
	        this.generated = source["generated"];
	        this.whitespaceOnly = source["whitespaceOnly"];
	    }
	}
	export class LocalBranch {
	    name: string;
	    base: string;
	    ahead: number;
	
	    static createFrom(source: any = {}) {
	        return new LocalBranch(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.base = source["base"];
	        this.ahead = source["ahead"];
	    }
	}
	export class LocalReview {
	    title: string;
	    detail: string;
	    base: string;
	    head: string;
	
	    static createFrom(source: any = {}) {
	        return new LocalReview(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.title = source["title"];
	        this.detail = source["detail"];
	        this.base = source["base"];
	        this.head = source["head"];
	    }
	}
	export class LocalSubjects {
	    branch?: LocalBranch;
	    commits: CommitRef[];
	
	    static createFrom(source: any = {}) {
	        return new LocalSubjects(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.branch = this.convertValues(source["branch"], LocalBranch);
	        this.commits = this.convertValues(source["commits"], CommitRef);
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
	export class OpenLink {
	    slug: string;
	    pr: number;
	
	    static createFrom(source: any = {}) {
	        return new OpenLink(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.slug = source["slug"];
	        this.pr = source["pr"];
	    }
	}
	export class OpenRequest {
	    repo: string;
	    error: string;
	    review?: LocalReview;
	    link?: OpenLink;
	
	    static createFrom(source: any = {}) {
	        return new OpenRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.repo = source["repo"];
	        this.error = source["error"];
	        this.review = this.convertValues(source["review"], LocalReview);
	        this.link = this.convertValues(source["link"], OpenLink);
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
	
	export class RefList {
	    branches: string[];
	    defaultBase: string;
	    commits: CommitRef[];
	
	    static createFrom(source: any = {}) {
	        return new RefList(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.branches = source["branches"];
	        this.defaultBase = source["defaultBase"];
	        this.commits = this.convertValues(source["commits"], CommitRef);
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

