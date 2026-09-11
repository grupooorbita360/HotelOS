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
        Relationships: [];
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
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
