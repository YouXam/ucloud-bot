

export interface UserRecord {
    username: string;
    password: string;
    userinfo: string
}

export interface CourseInfo {
    id: number;
    name: string;
    teachers: string;
}

export interface UndoneListItem {
    siteId: number;
    siteName: string;
    activityName: string;
    activityId: string;
    type: number;
    endTime: string;
    assignmentType: number;
    evaluationStatus: number;
    isOpenEvaluation: number;
    courseInfo: CourseInfo;
}

export interface ResourceDetail {
    storageId: string;
    name: string;
    ext: string;
    url: string;
    id: string;
}


export interface UndoneList {
    siteNum: number;
    undoneNum: number;
    undoneList: UndoneListItem[];
}
export interface UndoneListResult {
    success: boolean;
    message: string;
    data: UndoneList;
}

export interface Detail {
    id: string;
    assignmentTitle: string;
    assignmentContent: string;
    assignmentComment: string;
    className: string;
    chapterName: string;
    assignmentType: number;
    noSubmitNum: number;
    totalNum: number;
    stayReadNum: number;
    alreadyReadNum: number;
    isGroupExcellent: number;
    assignmentBeginTime: string;
    assignmentEndTime: string;
    isOvertimeCommit: number;
    assignmentStatus: number;
    teamId: number;
    isOpenEvaluation: number;
    status: number;
    groupScore: number;
    assignmentScore: number;
    assignmentResource: any[];
    assignmentMutualEvaluation: any;
    courseInfo?: CourseInfo;
    key?: string;
    resource?: ResourceDetail[];
}

export interface DetailResult {
    success: boolean;
    message: string;
    data: Detail;
}

export interface ShortURL {
    key: string;
    username: string;
    homework_id: string;
}

export interface User {
    id: number;
    username: string;
    password: string;
    push: boolean;
    undoneList: string;
}

export interface Attachment {
    resourceId: string;
    url: string;
    filename: string;
    mime_type: string;
}

export interface Submitting {
    id?: number;
    username: string;
    assignment_id: string;
    isSubmitting: boolean;
    content: string;
    attachments: Attachment[];
    messageId: string | null;
    channelId: string;
    reply_to: string;
    detail: Detail;
}