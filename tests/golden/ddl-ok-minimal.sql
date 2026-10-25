create table scott.log1 (
    msg varchar2(2000)
);

comment on table scott.log1 is '日志表';
comment on column scott.log1.msg is '消息';
