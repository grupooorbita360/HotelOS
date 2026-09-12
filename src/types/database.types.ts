/**
 * Tipos de la base de datos, escritos a mano para reflejar las migraciones
 * en supabase/migrations/. En cuanto exista un proyecto de Supabase real,
 * reemplaza este archivo con la salida generada del CLI para que quede
 * siempre sincronizado con el esquema real:
 *
 *   npx supabase gen types typescript --linked --schema public > src/types/database.types.ts
 *
 * No edites a mano un archivo generado; si necesitas un tipo que no está
 * aquí todavía, agrega la migración primero y luego regenera.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type HotelPlan = "basico" | "plus" | "pro";
export type HotelStatus = "trial" | "active" | "suspended" | "canceled";

export interface Database {
  public: {
    Tables: {
      hotels: {
        Row: {
          id: string;
          name: string;
          slug: string;
          plan: HotelPlan;
          status: HotelStatus;
          timezone: string;
          country: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          plan?: HotelPlan;
          status?: HotelStatus;
          timezone?: string;
          country?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["hotels"]["Insert"]>;
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          full_name: string | null;
          email: string | null;
          phone: string | null;
          is_platform_admin: boolean;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          full_name?: string | null;
          phone?: string | null;
          is_active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [];
      };
      roles: {
        Row: {
          id: string;
          hotel_id: string | null;
          name: string;
          description: string | null;
          is_system: boolean;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          hotel_id?: string | null;
          name: string;
          description?: string | null;
          is_system?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["roles"]["Insert"]>;
        Relationships: [];
      };
      permissions: {
        Row: {
          id: string;
          code: string;
          module: string;
          description: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          code: string;
          module: string;
          description?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["permissions"]["Insert"]>;
        Relationships: [];
      };
      role_permissions: {
        Row: {
          role_id: string;
          permission_id: string;
          created_at: string;
          created_by: string | null;
        };
        Insert: {
          role_id: string;
          permission_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["role_permissions"]["Insert"]>;
        Relationships: [];
      };
      user_hotel_roles: {
        Row: {
          id: string;
          user_id: string;
          hotel_id: string;
          role_id: string;
          is_active: boolean;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          user_id: string;
          hotel_id: string;
          role_id: string;
          is_active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["user_hotel_roles"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "user_hotel_roles_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_hotel_roles_role_id_fkey";
            columns: ["role_id"];
            isOneToOne: false;
            referencedRelation: "roles";
            referencedColumns: ["id"];
          },
        ];
      };
      hotel_policies: {
        Row: {
          id: string;
          hotel_id: string;
          requires_guarantee: boolean;
          guarantee_notes: string | null;
          allows_early_checkin: boolean;
          standard_checkin_time: string;
          standard_checkout_time: string;
          checkin_assets: Json;
          extra_settings: Json;
          iva_porcentaje: number;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          hotel_id: string;
          requires_guarantee?: boolean;
          guarantee_notes?: string | null;
          allows_early_checkin?: boolean;
          standard_checkin_time?: string;
          standard_checkout_time?: string;
          checkin_assets?: Json;
          extra_settings?: Json;
          iva_porcentaje?: number;
        };
        Update: Partial<Database["public"]["Tables"]["hotel_policies"]["Insert"]>;
        Relationships: [];
      };
      timeline_events: {
        Row: {
          id: string;
          hotel_id: string;
          module: string;
          event_type: string;
          entity_type: string;
          entity_id: string | null;
          payload: Json;
          actor_user_id: string | null;
          occurred_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          hotel_id: string;
          module: string;
          event_type: string;
          entity_type: string;
          entity_id?: string | null;
          payload?: Json;
          actor_user_id: string;
          occurred_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      room_types: {
        Row: {
          id: string;
          hotel_id: string;
          name: string;
          code: string;
          capacity_adults: number;
          capacity_children: number;
          accepts_pets: boolean;
          base_rate: number;
          is_active: boolean;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          hotel_id: string;
          name: string;
          code: string;
          capacity_adults?: number;
          capacity_children?: number;
          accepts_pets?: boolean;
          base_rate?: number;
          is_active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["room_types"]["Insert"]>;
        Relationships: [];
      };
      rooms: {
        Row: {
          id: string;
          hotel_id: string;
          room_type_id: string;
          code: string;
          building: string | null;
          bed_type: string | null;
          is_active: boolean;
          is_clean: boolean;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          hotel_id: string;
          room_type_id: string;
          code: string;
          building?: string | null;
          bed_type?: string | null;
          is_active?: boolean;
          is_clean?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["rooms"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "rooms_room_type_id_fkey";
            columns: ["room_type_id"];
            isOneToOne: false;
            referencedRelation: "room_types";
            referencedColumns: ["id"];
          },
        ];
      };
      leads: {
        Row: {
          id: string;
          hotel_id: string;
          guest_name: string;
          guest_email: string | null;
          guest_phone: string | null;
          pax_adults: number;
          pax_children: number;
          has_pets: boolean;
          desired_check_in: string | null;
          desired_check_out: string | null;
          desired_room_type_id: string | null;
          channel: string;
          status: string;
          lost_reason: string | null;
          reservation_id: string | null;
          first_contact_at: string;
          last_interaction_at: string;
          next_action_at: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          hotel_id: string;
          guest_name: string;
          guest_email?: string | null;
          guest_phone?: string | null;
          pax_adults?: number;
          pax_children?: number;
          has_pets?: boolean;
          desired_check_in?: string | null;
          desired_check_out?: string | null;
          desired_room_type_id?: string | null;
          channel?: string;
          status?: string;
          lost_reason?: string | null;
          next_action_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["leads"]["Insert"]>;
        Relationships: [];
      };
      quotes: {
        Row: {
          id: string;
          hotel_id: string;
          lead_id: string;
          status: string;
          currency: string;
          cancellation_policy_snapshot: Json;
          price_valid_until: string;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          hotel_id: string;
          lead_id: string;
          status?: string;
          currency?: string;
          cancellation_policy_snapshot?: Json;
          price_valid_until: string;
        };
        Update: Partial<Database["public"]["Tables"]["quotes"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "quotes_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
      };
      quote_options: {
        Row: {
          id: string;
          hotel_id: string;
          quote_id: string;
          room_type_id: string;
          check_in: string;
          check_out: string;
          adults: number;
          children: number;
          has_pets: boolean;
          subtotal: number;
          taxes: number;
          total: number;
          rules_applied: Json;
          created_at: string;
          created_by: string | null;
        };
        Insert: {
          id?: string;
          hotel_id: string;
          quote_id: string;
          room_type_id: string;
          check_in: string;
          check_out: string;
          adults?: number;
          children?: number;
          has_pets?: boolean;
          subtotal: number;
          taxes?: number;
          total: number;
          rules_applied?: Json;
        };
        Update: Partial<Database["public"]["Tables"]["quote_options"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "quote_options_quote_id_fkey";
            columns: ["quote_id"];
            isOneToOne: false;
            referencedRelation: "quotes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "quote_options_room_type_id_fkey";
            columns: ["room_type_id"];
            isOneToOne: false;
            referencedRelation: "room_types";
            referencedColumns: ["id"];
          },
        ];
      };
      inventory_holds: {
        Row: {
          id: string;
          hotel_id: string;
          room_type_id: string;
          quote_option_id: string | null;
          check_in: string;
          check_out: string;
          status: string;
          expires_at: string;
          converted_reservation_id: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "inventory_holds_room_type_id_fkey";
            columns: ["room_type_id"];
            isOneToOne: false;
            referencedRelation: "room_types";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "inventory_holds_quote_option_id_fkey";
            columns: ["quote_option_id"];
            isOneToOne: false;
            referencedRelation: "quote_options";
            referencedColumns: ["id"];
          },
        ];
      };
      inventory_blocks: {
        Row: {
          id: string;
          hotel_id: string;
          room_type_id: string;
          stay_date: string;
          block_type: string;
          hold_id: string | null;
          reservation_stay_id: string | null;
          created_at: string;
          room_id: string | null;
          reason: string | null;
          created_by: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "inventory_blocks_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      reservations: {
        Row: {
          id: string;
          hotel_id: string;
          folio: string;
          lead_id: string | null;
          quote_id: string | null;
          hold_id: string | null;
          primary_guest_name: string;
          primary_guest_email: string | null;
          primary_guest_phone: string | null;
          channel: string;
          status: string;
          cancellation_policy_snapshot: Json;
          cancelled_at: string | null;
          cancellation_reason: string | null;
          refund_amount: number | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: never;
        Update: {
          primary_guest_name?: string;
          primary_guest_email?: string | null;
          primary_guest_phone?: string | null;
        };
        Relationships: [];
      };
      reservation_stays: {
        Row: {
          id: string;
          hotel_id: string;
          reservation_id: string;
          room_type_id: string;
          room_id: string | null;
          check_in: string;
          check_out: string;
          adults: number;
          children: number;
          has_pets: boolean;
          rate_total: number;
          estimated_arrival_time: string | null;
          notes_guest: string | null;
          notes_internal: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: never;
        Update: {
          room_id?: string | null;
          notes_guest?: string | null;
          notes_internal?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "reservation_stays_reservation_id_fkey";
            columns: ["reservation_id"];
            isOneToOne: false;
            referencedRelation: "reservations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reservation_stays_room_type_id_fkey";
            columns: ["room_type_id"];
            isOneToOne: false;
            referencedRelation: "room_types";
            referencedColumns: ["id"];
          },
        ];
      };
      guarantees: {
        Row: {
          id: string;
          hotel_id: string;
          reservation_id: string;
          type: string;
          amount: number;
          currency: string;
          status: string;
          released_at: string | null;
          charged_at: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          hotel_id: string;
          reservation_id: string;
          type: string;
          amount: number;
          currency?: string;
          status?: string;
        };
        Update: Partial<Database["public"]["Tables"]["guarantees"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "guarantees_reservation_id_fkey";
            columns: ["reservation_id"];
            isOneToOne: false;
            referencedRelation: "reservations";
            referencedColumns: ["id"];
          },
        ];
      };
      payments: {
        Row: {
          id: string;
          hotel_id: string;
          reservation_id: string;
          type: string;
          amount: number;
          currency: string;
          exchange_rate_applied: number;
          amount_local: number;
          method: string;
          status: string;
          receipt_url: string | null;
          notes: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          hotel_id: string;
          reservation_id: string;
          type: string;
          amount: number;
          currency?: string;
          exchange_rate_applied?: number;
          amount_local: number;
          method: string;
          status?: string;
          receipt_url?: string | null;
          notes?: string | null;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: "payments_reservation_id_fkey";
            columns: ["reservation_id"];
            isOneToOne: false;
            referencedRelation: "reservations";
            referencedColumns: ["id"];
          },
        ];
      };
      reception_settings: {
        Row: {
          id: string;
          hotel_id: string;
          entrega_permite_saldo: boolean;
          checkin_permite_sucia: boolean;
          noshow_dias_gracia: number;
          bloquear_checkout_saldo: boolean;
          extra_settings: Json;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          hotel_id: string;
          entrega_permite_saldo?: boolean;
          checkin_permite_sucia?: boolean;
          noshow_dias_gracia?: number;
          bloquear_checkout_saldo?: boolean;
          extra_settings?: Json;
        };
        Update: Partial<Database["public"]["Tables"]["reception_settings"]["Insert"]>;
        Relationships: [];
      };
      stays: {
        Row: {
          id: string;
          hotel_id: string;
          reservation_stay_id: string;
          status: string;
          next_action: string;
          arrived_at: string | null;
          checked_in_at: string | null;
          in_house_at: string | null;
          checked_out_at: string | null;
          no_show_at: string | null;
          walked_at: string | null;
          no_show_reason: string | null;
          walked_reason: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "stays_reservation_stay_id_fkey";
            columns: ["reservation_stay_id"];
            isOneToOne: true;
            referencedRelation: "reservation_stays";
            referencedColumns: ["id"];
          },
        ];
      };
      room_assignments: {
        Row: {
          id: string;
          hotel_id: string;
          stay_id: string;
          room_id: string;
          assigned_at: string;
          released_at: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "room_assignments_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      stay_accounts: {
        Row: {
          id: string;
          hotel_id: string;
          stay_id: string;
          currency: string;
          status: string;
          balance: number;
          closed_at: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "stay_accounts_stay_id_fkey";
            columns: ["stay_id"];
            isOneToOne: true;
            referencedRelation: "stays";
            referencedColumns: ["id"];
          },
        ];
      };
      stay_transactions: {
        Row: {
          id: string;
          hotel_id: string;
          stay_account_id: string;
          type: string;
          amount: number;
          concept: string;
          method: string | null;
          reversed_transaction_id: string | null;
          created_at: string;
          created_by: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      guest_requests: {
        Row: {
          id: string;
          hotel_id: string;
          stay_id: string;
          description: string;
          status: string;
          resolved_at: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          hotel_id: string;
          stay_id: string;
          description: string;
          status?: string;
        };
        Update: Partial<Database["public"]["Tables"]["guest_requests"]["Insert"]> & {
          resolved_at?: string | null;
        };
        Relationships: [];
      };
      stay_incidents: {
        Row: {
          id: string;
          hotel_id: string;
          stay_id: string;
          room_id: string | null;
          type: string;
          severity: string;
          description: string;
          status: string;
          resolved_at: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          hotel_id: string;
          stay_id: string;
          room_id?: string | null;
          type: string;
          severity?: string;
          description: string;
          status?: string;
        };
        Update: Partial<Database["public"]["Tables"]["stay_incidents"]["Insert"]> & {
          resolved_at?: string | null;
        };
        Relationships: [];
      };
      delivered_assets: {
        Row: {
          id: string;
          hotel_id: string;
          stay_id: string;
          asset_name: string;
          delivered: boolean;
          delivered_at: string | null;
          returned: boolean;
          returned_at: string | null;
          created_at: string;
          created_by: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          hotel_id: string;
          stay_id: string;
          asset_name: string;
          delivered?: boolean;
          delivered_at?: string | null;
          returned?: boolean;
          returned_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["delivered_assets"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_platform_admin: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      has_permission: {
        Args: { p_hotel_id: string; p_permission_code: string };
        Returns: boolean;
      };
      check_availability: {
        Args: {
          p_hotel_id: string;
          p_room_type_id: string;
          p_check_in: string;
          p_check_out: string;
        };
        Returns: {
          stay_date: string;
          total_units: number;
          blocked_units: number;
          available_units: number;
        }[];
      };
      attempt_inventory_hold: {
        Args: {
          p_hotel_id: string;
          p_room_type_id: string;
          p_check_in: string;
          p_check_out: string;
          p_quote_option_id?: string | null;
          p_hold_minutes?: number | null;
        };
        Returns: Database["public"]["Tables"]["inventory_holds"]["Row"];
      };
      confirm_reservation_from_hold: {
        Args: {
          p_hold_id: string;
          p_primary_guest_name: string;
          p_primary_guest_email?: string | null;
          p_primary_guest_phone?: string | null;
          p_channel?: string;
          p_rate_total?: number;
          p_cancellation_policy_snapshot?: Json;
          p_adults?: number;
          p_children?: number;
          p_has_pets?: boolean;
          p_estimated_arrival_time?: string | null;
        };
        Returns: Database["public"]["Tables"]["reservations"]["Row"];
      };
      release_hold: {
        Args: { p_hold_id: string };
        Returns: undefined;
      };
      cancel_reservation: {
        Args: { p_reservation_id: string; p_reason?: string | null };
        Returns: Database["public"]["Tables"]["reservations"]["Row"];
      };
      expire_stale_holds: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      can_deliver_room: {
        Args: { p_stay_id: string };
        Returns: { allowed: boolean; reason: string | null }[];
      };
      check_out_readiness: {
        Args: { p_stay_id: string };
        Returns: { ready: boolean; blockers: string[] };
      };
      register_arrival: {
        Args: { p_stay_id: string };
        Returns: Database["public"]["Tables"]["stays"]["Row"];
      };
      check_in: {
        Args: { p_stay_id: string };
        Returns: Database["public"]["Tables"]["stays"]["Row"];
      };
      assign_room: {
        Args: { p_stay_id: string; p_room_id: string };
        Returns: Database["public"]["Tables"]["room_assignments"]["Row"];
      };
      deliver_room: {
        Args: { p_stay_id: string };
        Returns: Database["public"]["Tables"]["stays"]["Row"];
      };
      mark_no_show: {
        Args: { p_stay_id: string; p_reason?: string | null };
        Returns: Database["public"]["Tables"]["stays"]["Row"];
      };
      mark_walked: {
        Args: { p_stay_id: string; p_reason?: string | null };
        Returns: Database["public"]["Tables"]["stays"]["Row"];
      };
      register_stay_transaction: {
        Args: {
          p_stay_id: string;
          p_type: string;
          p_amount: number;
          p_concept: string;
          p_method?: string | null;
        };
        Returns: Database["public"]["Tables"]["stay_transactions"]["Row"];
      };
      void_stay_transaction: {
        Args: { p_transaction_id: string; p_reason?: string | null };
        Returns: Database["public"]["Tables"]["stay_transactions"]["Row"];
      };
      attempt_check_out: {
        Args: { p_stay_id: string };
        Returns: Database["public"]["Tables"]["stays"]["Row"];
      };
      find_user_id_by_email: {
        Args: { p_hotel_id: string; p_email: string };
        Returns: string | null;
      };
      assign_room_for_checkin: {
        Args: { p_stay_id: string; p_room_id: string };
        Returns: Database["public"]["Tables"]["room_assignments"]["Row"];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
