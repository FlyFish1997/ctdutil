create table public.t_order (
    order_id varchar2(32),
    amount numeric(18,4),
    qty integer,
    order_date date
);

comment on table public.t_order is '订单主表';
comment on column public.t_order.order_id is '订单号';
comment on column public.t_order.amount is '金额';
comment on column public.t_order.qty is '数量';
comment on column public.t_order.order_date is '下单日期';

alter table public.t_order add constraint pk_t_order primary key (order_id);

create index idx_t_order_01 on public.t_order (order_date);

create index idx_t_order_02 on public.t_order (order_id, order_date);
