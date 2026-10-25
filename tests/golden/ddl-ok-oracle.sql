create table scott.emp (
    emp_no varchar2(20),
    emp_name varchar2(50),
    sal number(10,2),
    age integer,
    hire_date date,
    created_at timestamp
);

comment on table scott.emp is '员工信息表';
comment on column scott.emp.emp_no is '员工编号';
comment on column scott.emp.emp_name is '员工姓名''含单引号';
comment on column scott.emp.sal is '薪资';
comment on column scott.emp.age is '年龄';
comment on column scott.emp.hire_date is '入职日期';
comment on column scott.emp.created_at is '创建时间';

alter table scott.emp add constraint pk_emp primary key (emp_no, emp_name);

create index idx_emp_01 on scott.emp (emp_name, hire_date);

create unique index idx_emp_02 on scott.emp (sal);
