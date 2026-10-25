create table public.t_order (
    order_id varchar(32) not null,
    amount numeric(18,4),
    qty int,
    order_date date,
    created_at timestamp
);

comment on table public.t_order is '订单主表（H2 文件模式）';
comment on column public.t_order.order_id is '订单号';
comment on column public.t_order.amount is '金额';
comment on column public.t_order.qty is '数量';
comment on column public.t_order.order_date is '下单日期';
comment on column public.t_order.created_at is '创建时间';

alter table public.t_order add constraint pk_t_order primary key (order_id);

create index idx_t_order_01 on public.t_order (order_date);
