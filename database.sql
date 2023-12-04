-- DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS submitting;

-- CREATE TABLE users (
--     id VARCHAR(255) PRIMARY KEY,
--     username VARCHAR(255),
--     password VARCHAR(255),
--     push BOOLEAN,
--     undoneList TEXT
-- );

CREATE TABLE submitting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username VARCHAR(255) UNIQUE,
    is_submitting BOOLEAN,
    assignment_id VARCHAR(255),
    content TEXT,
    attachments TEXT,
    message_id VARCHAR(255),
    channelId VARCHAR(255),
    reply_to VARCHAR(255),
    detail TEXT
);
